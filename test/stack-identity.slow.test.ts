import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Postgres } from './support/postgres';
import { Repo } from './support/repo';

const postgres = new Postgres();
const repos: Repo[] = [];
beforeAll(async () => {
  await postgres.start();
}, 60_000);
afterAll(async () => {
  await postgres.close();
});
afterEach(() => {
  for (const r of repos.splice(0)) r.close();
});
function declaration(inputs: unknown[], extra = {}) {
  return JSON.stringify({
    version: 1,
    project: 'stack',
    tasks: {
      gate: { run: 'test ! -f .env.docker && echo executed', inputs, ...extra },
    },
  });
}
function fixture(inputs: unknown[], files = {}, extra = {}) {
  const repo = new Repo();
  repos.push(repo);
  repo.commit({
    '.gitignore': '.env.docker\n',
    'proof.yaml': declaration(inputs, extra),
    ...files,
  });
  const env = { PROOF_STATE_DIR: join(repo.path, '.git/state') };
  const cli = (...args: string[]) => repo.cli(args, env);
  return { repo, env, cli };
}
function success(r: ReturnType<Repo['cli']>) {
  expect(r.code).toBe(0);
  return r.out;
}

test('dotenv declarations validate fields, exclusions, projections and checkout paths', () => {
  for (const [input, diagnostic] of [
    [{ dotenv: '.env.docker', typo: true }, "unknown field 'typo'"],
    ...[[], 'FLAG', [''], [1]].map(
      (exclude) => [{ dotenv: '.env.docker', exclude }, 'exclude'] as const,
    ),
    ...['/outside', '../outside', 'a//b', './a', '.git/a', 'a/'].map(
      (dotenv) => [{ dotenv }, 'unsafe dotenv'] as const,
    ),
    [{ path: '.env.example', 'dotenv-keys': false }, 'dotenv-keys must be true'],
    [{ path: '.env.example', json: ['A'], 'dotenv-keys': true }, 'not both'],
  ] as const) {
    const f = fixture([input]);
    const r = f.cli('plan');
    expect(r.code).toBe(2);
    expect(r.err).toContain("task 'gate'");
    expect(r.err).toContain(diagnostic);
  }
  const f = fixture([{ dotenv: '.env.docker' }]);
  expect(f.cli('lint').code).toBe(0);
  f.repo.write('.env.docker', 'FLAG=one');
  expect(f.cli('lint').code).toBe(0);
});

test('tracked dotenv names project at refs, retain whole inputs and reject dirty edits', () => {
  const input = { path: '.env.example', 'dotenv-keys': true };
  const f = fixture([input], { '.env.example': 'export A=one\nB="two#literal" # comment\n' });
  const a = f.repo.git('rev-parse', 'HEAD');
  expect(success(f.cli('run'))).toContain('green gate');
  expect(success(f.cli('plan'))).toContain('PROVEN gate');
  const b = f.repo.commit({ '.env.example': "# comment\nB='different'\nA = changed # inline\n" });
  expect(success(f.cli('plan'))).toContain('PROVEN gate');
  for (const staged of [false, true]) {
    f.repo.write('.env.example', 'A=dirty\nB=two');
    if (staged) f.repo.git('add', '.env.example');
    expect(success(f.cli('plan'))).toContain("undecidable: dirty input '.env.example'");
    f.repo.git('reset', '--hard', b);
  }
  const c = f.repo.commit({ '.env.example': 'A=x\nB=y\nC=' });
  expect(success(f.cli('why', 'gate'))).toContain('changed member .env.example dotenv-keys');
  expect(
    success(
      f.repo.check([
        { name: 'values', from: a, to: b, expect: [] },
        { name: 'names', from: b, to: c, expect: ['gate'] },
      ]),
    ),
  ).toContain('PASS names');
  f.repo.commit({ 'proof.yaml': declaration([input, '.env.example']) });
  expect(success(f.cli('run'))).toContain('green gate');
  f.repo.commit({ '.env.example': 'A=changed\nB=y\nC=' });
  expect(success(f.cli('plan'))).toContain('RUN gate');
});

test('checkout dotenv values key alone, canonicalize, explain and stay secret in both stores', async () => {
  const f = fixture([{ dotenv: '.env.docker', exclude: ['API_KEY'] }]);
  const remote = await postgres.database();
  const env = { ...f.env, PROOF_STORE: remote.PROOF_STORE };
  const secrets = ['included-private-marker', 'excluded-private-marker'];
  const cli = (...args: string[]) => {
    const r = f.repo.cli(args, env);
    for (const secret of secrets) expect(r.out + r.err).not.toContain(secret);
    expect(r.code).toBe(args[0] === 'status' && r.out.includes('RUN gate') ? 1 : 0);
    return r.out;
  };
  f.repo.write('.env.docker', `FLAG=${secrets[0]}\nAPI_KEY=${secrets[1]}`);
  const a = f.repo.git('rev-parse', 'HEAD');
  expect(cli('run')).toContain('green gate');
  expect(cli('plan')).toContain('PROVEN gate');
  const b = f.repo.commit({ unrelated: 'new commit' });
  f.repo.write('.env.docker', 'FLAG=changed\nAPI_KEY=changed');
  expect(cli('why', 'gate')).toContain('changed env .env.docker:FLAG');
  for (const ref of [a, b]) expect(cli('status', '--ref', ref)).toContain('RUN gate');
  f.repo.write('.env.docker', `API_KEY=changed\nexport FLAG='${secrets[0]}' # inline`);
  for (const ref of [a, b]) expect(cli('status', '--ref', ref)).toContain('PROVEN gate');
  expect(cli('plan', '--json')).toContain('PROVEN');
  f.repo.commit({
    'proof.yaml': declaration([
      { dotenv: '.env.docker', exclude: ['API_KEY', 'API_KEY'] },
      { dotenv: '.env.docker', exclude: ['API_KEY'] },
    ]),
  });
  expect(cli('plan')).toContain('PROVEN gate');
  for (const text of ['FLAG=changed', 'FLAG=changed\nEMPTY=', '']) {
    f.repo.write('.env.docker', text);
    expect(cli('plan')).toContain('RUN gate');
    expect(cli('run')).toContain('green gate');
    expect(cli('plan')).toContain('PROVEN gate');
  }
  f.repo.write('.env.docker', `FLAG=valid\n${secrets[1]}`);
  for (const args of [
    ['plan'],
    ['plan', '--json'],
    ['why', 'gate'],
    ['run'],
    ['status', '--ref', 'HEAD'],
  ])
    expect(cli(...args)).toContain('undecidable');
  const db = new Database(join(f.env.PROOF_STATE_DIR, 'proof.db'));
  try {
    for (const table of ['results', 'proofs']) {
      const local = db.query(`SELECT * FROM ${table}`).all();
      const shared = await remote.sql.unsafe(`SELECT * FROM ${table}`);
      expect(local).toHaveLength(4);
      expect(shared).toHaveLength(4);
    }
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[];
    const remoteTables =
      await remote.sql`SELECT tablename FROM pg_tables WHERE schemaname='public'`;
    for (const secret of secrets) {
      for (const { name } of tables)
        expect(JSON.stringify(db.query(`SELECT * FROM "${name}"`).all())).not.toContain(secret);
      for (const { tablename } of remoteTables)
        expect(
          JSON.stringify(await remote.sql.unsafe(`SELECT * FROM "${tablename}"`)),
        ).not.toContain(secret);
    }
  } finally {
    db.close();
  }
  f.repo.write('.env.docker', `FLAG=${secrets[0]}`);
  expect(cli('run', '--fresh')).toContain('green gate');
  f.repo.commit({ 'proof.yaml': declaration(['unrelated']) });
  rmSync(join(f.repo.path, '.env.docker'));
  const explained = cli('why', 'gate');
  expect(explained).toContain('changed env .env.docker:FLAG');
  expect(explained).not.toContain('proof undecidable');
});

test('missing, malformed and symlink dotenv inputs run undecidable without publication or leaks', () => {
  const secret = 'invalid-private-marker';
  for (const projection of [false, true]) {
    const path = projection ? '.env.example' : '.env.docker';
    const input = projection ? { path, 'dotenv-keys': true } : { dotenv: path };
    const f = fixture([input], projection ? { [path]: 'A=valid' } : {});
    if (!projection) f.repo.write(path, 'A=valid');
    expect(success(f.cli('run'))).toContain('green gate');
    const db = new Database(join(f.env.PROOF_STATE_DIR, 'proof.db'));
    const before = db.query('SELECT * FROM results').all();
    for (const bad of [
      undefined,
      `A=ok\n${secret}`,
      `A=ok\nB="${secret}`,
      `A=ok\nB='x'tail`,
      `A=ok\nB="x"#tail`,
    ]) {
      if (bad === undefined) {
        rmSync(join(f.repo.path, path));
        if (projection) {
          f.repo.git('add', path);
          f.repo.git('commit', '-qm', 'remove');
        }
      } else if (projection) f.repo.commit({ [path]: bad });
      else f.repo.write(path, bad);
      for (const args of [['plan'], ['why', 'gate'], ['run']]) {
        const r = f.cli(...args);
        const out = success(r);
        expect(out).toContain('undecidable');
        expect(out).toContain(path);
        if (bad !== undefined) expect(out).toContain('line 2');
        expect(out + r.err).not.toContain(secret);
      }
      expect(db.query('SELECT * FROM results').all()).toEqual(before);
    }
    db.close();
    if (!projection) {
      rmSync(join(f.repo.path, path));
      symlinkSync('proof.yaml', join(f.repo.path, path));
      expect(success(f.cli('plan'))).toContain('undecidable');
    }
  }
});

test('tracked dotenv values use checkout at old refs; ignored links provide access', () => {
  const f = fixture(
    [{ dotenv: 'stack.conf' }],
    { 'stack.conf': 'A=old' },
    { run: 'test ! -f stack.conf' },
  );
  const a = f.repo.git('rev-parse', 'HEAD');
  f.repo.commit({ 'stack.conf': 'A=new' });
  expect(success(f.cli('run'))).toContain('green gate');
  expect(success(f.cli('status', '--ref', a))).toContain('PROVEN gate');
  const linked = fixture(
    [{ dotenv: '.env.docker' }],
    {},
    {
      links: ['.env.docker'],
      run: 'test -f .env.docker',
    },
  );
  linked.repo.write('.env.docker', 'A=value');
  expect(success(linked.cli('run'))).toContain('green gate');
});

test('dotenv grammar preserves literal characters and last assignments', () => {
  const f = fixture([{ dotenv: '.env.docker' }]);
  f.repo.write(
    '.env.docker',
    '# comment\nexport A = overwritten\nA=b#c # outside\nB="literal#hash"\nC=\'single\'\nD="escaped\\"quote"\nEMPTY=\n',
  );
  expect(success(f.cli('run'))).toContain('green gate');
  f.repo.write(
    '.env.docker',
    "EMPTY= # empty\nD='escaped\\\"quote'\nC=single\nB='literal#hash'\nexport A=\"b#c\"\n",
  );
  expect(success(f.cli('plan'))).toContain('PROVEN gate');
});

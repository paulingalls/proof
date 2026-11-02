import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
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
      gate: { run: 'test ! -f stack.conf && echo executed', inputs, ...extra },
    },
  });
}
function fixture(inputs: unknown[], files = {}, extra = {}) {
  const repo = new Repo();
  repos.push(repo);
  repo.commit({
    '.gitignore': 'stack.conf\n',
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
    [{ dotenv: 'stack.conf', typo: true }, "unknown field 'typo'"],
    ...[[], 'FLAG', [''], [1]].map(
      (exclude) => [{ dotenv: 'stack.conf', exclude }, 'exclude'] as const,
    ),
    ...['/outside', '../outside', 'a//b', './a', '.git/a', 'a/'].map(
      (dotenv) => [{ dotenv }, 'unsafe dotenv'] as const,
    ),
    [{ path: 'example.conf', 'dotenv-keys': false }, 'dotenv-keys must be true'],
    [{ path: 'example.conf', json: ['A'], 'dotenv-keys': true }, 'not both'],
  ] as const) {
    const f = fixture([input]);
    const r = f.cli('plan');
    expect(r.code).toBe(2);
    expect(r.err).toContain("task 'gate'");
    expect(r.err).toContain(diagnostic);
  }
  const f = fixture([{ dotenv: 'stack.conf' }]);
  expect(f.cli('lint').code).toBe(0);
  f.repo.write('stack.conf', 'FLAG=one');
  expect(f.cli('lint').code).toBe(0);
});

test('tracked dotenv names project at refs, retain whole inputs and reject dirty edits', () => {
  const input = { path: 'example.conf', 'dotenv-keys': true };
  const f = fixture([input], { 'example.conf': 'export A=one\nB="two#literal" # comment\n' });
  const a = f.repo.git('rev-parse', 'HEAD');
  expect(success(f.cli('run'))).toContain('green gate');
  expect(success(f.cli('plan'))).toContain('PROVEN gate');
  const b = f.repo.commit({ 'example.conf': "# comment\nB='different'\nA = changed # inline\n" });
  expect(success(f.cli('plan'))).toContain('PROVEN gate');
  for (const staged of [false, true]) {
    f.repo.write('example.conf', 'A=dirty\nB=two');
    if (staged) f.repo.git('add', 'example.conf');
    expect(success(f.cli('plan'))).toContain("undecidable: dirty input 'example.conf'");
    f.repo.git('reset', '--hard', b);
  }
  const c = f.repo.commit({ 'example.conf': 'A=x\nB=y\nC=' });
  expect(success(f.cli('why', 'gate'))).toContain('changed member example.conf dotenv-keys');
  expect(
    success(
      f.repo.check([
        { name: 'values', from: a, to: b, expect: [] },
        { name: 'names', from: b, to: c, expect: ['gate'] },
      ]),
    ),
  ).toContain('PASS names');
  f.repo.commit({ 'proof.yaml': declaration([input, 'example.conf']) });
  expect(success(f.cli('run'))).toContain('green gate');
  f.repo.commit({ 'example.conf': 'A=changed\nB=y\nC=' });
  expect(success(f.cli('plan'))).toContain('RUN gate');
});

test('checkout dotenv values, missing and malformed files never enter either store key', async () => {
  const f = fixture([{ dotenv: 'stack.conf' }]);
  const remote = await postgres.database();
  const env = { ...f.env, PROOF_STORE: remote.PROOF_STORE };
  const cli = (...args: string[]) => success(f.repo.cli(args, env));
  f.repo.write('stack.conf', 'FLAG=first');
  expect(cli('run')).toContain('green gate');
  const key = JSON.parse(cli('plan', '--json'))[0].key;
  for (const text of ['FLAG=second', 'malformed', undefined]) {
    if (text === undefined) rmSync(join(f.repo.path, 'stack.conf'));
    else f.repo.write('stack.conf', text);
    expect(JSON.parse(cli('plan', '--json'))[0]).toMatchObject({ key, state: 'PROVEN' });
    expect(cli('status', '--ref', 'HEAD')).toContain('PROVEN gate');
    expect(cli('why', 'gate')).not.toContain('env stack.conf:');
  }
  using db = new Database(join(f.env.PROOF_STATE_DIR, 'proof.db'));
  expect(db.query('SELECT env_hashes FROM proofs').all()).toEqual([{ env_hashes: '[]' }]);
  expect(await remote.sql`SELECT env_hashes FROM proofs`).toEqual([{ env_hashes: '[]' }]);
  f.repo.commit({ 'proof.yaml': declaration(['proof.yaml', '!proof.yaml']) });
  expect(JSON.parse(cli('plan', '--json'))[0]).toMatchObject({ key, state: 'PROVEN' });
});

test('missing and malformed tracked dotenv projections run undecidable without publication or leaks', () => {
  const secret = 'invalid-private-marker';
  const path = 'example.conf';
  const input = { path, 'dotenv-keys': true };
  const f = fixture([input], { [path]: 'A=valid' });
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
      f.repo.git('add', path);
      f.repo.git('commit', '-qm', 'remove');
    } else f.repo.commit({ [path]: bad });
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
});

test('deprecated dotenv declarations ignore tracked values at old refs; ignored links provide access', () => {
  const f = fixture(
    [{ dotenv: 'tracked.conf' }],
    { 'tracked.conf': 'A=old' },
    { run: 'test ! -f tracked.conf' },
  );
  const a = f.repo.git('rev-parse', 'HEAD');
  f.repo.commit({ 'tracked.conf': 'A=new' });
  expect(success(f.cli('run'))).toContain('green gate');
  expect(success(f.cli('status', '--ref', a))).toContain('PROVEN gate');
  const linked = fixture(
    [{ dotenv: 'stack.conf' }],
    {},
    {
      links: ['stack.conf'],
      run: 'test -f stack.conf',
    },
  );
  linked.repo.write('stack.conf', 'A=value');
  expect(success(linked.cli('run'))).toContain('green gate');
});

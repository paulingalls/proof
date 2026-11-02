import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Query } from '../src/store';
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
  for (const repo of repos.splice(0)) repo.close();
});
const oldHash = 'cba06b5736faf67e54b07b561eae94395e774c517a7d910a54369e1263ccfbd4';
const newerEnv = 'e143101231ed1dde017ddca8629fbb6b762ee20c55e036accda07dd65c847df7';
const toolHash = '2a97516c354b68848cdbd8f54a226a0a55b21ed138e207ad6c5cbb9c00aa5aea';
const envIdentities: [string, string][] = [
  ['FAIL', 'absent'],
  ['MODE', oldHash],
];
const toolIdentities: [string, string][] = [['dimension:tool', toolHash]];
// Captured from v0.17.2 before changing key construction.
const released = {
  env: ['3234cf7ba686b0aec4c57cb83a10b6a8824ecc7f8fc55da3c6e17d51e033652f', envIdentities],
  dotenv: [
    'd1bda96a512404928058506ea70a6472813880bc9db60b8bb4f95b18cec8680e',
    [['stack.conf:FLAG', oldHash]],
  ],
  mixed: [
    '8f317e8ce3f73af8f9cc62767ae089eb256d44af3b04e619e8f96d5b5326e22f',
    [...envIdentities, ...toolIdentities],
  ],
  plain: ['69a37b6778f3299b043dc37f9407fa93719bb19249df9a9cd79cfcc1c5d2bc9e', []],
  dimension: ['847321ae4a89d3423af8dee433fb617cee32c202d0a4f31addc66541d501ed3d', toolIdentities],
} satisfies Record<string, [string, [string, string][]]>;
type Id = keyof typeof released;
function fixture(PROOF_STORE?: string) {
  const repo = new Repo();
  repos.push(repo);
  const doc = {
    version: 1,
    project: 'rekey',
    dimensions: { tool: 'printf demo' },
    tasks: Object.fromEntries(
      Object.keys(released).map((id) => [
        id,
        {
          run: `test "\${FAIL:-}" != yes`,
          inputs: ['input', ...(id === 'dotenv' ? [{ dotenv: 'stack.conf' }] : [])],
          ...(id === 'env' || id === 'mixed' ? { env: ['MODE', 'FAIL'] } : {}),
          ...(id === 'dimension' || id === 'mixed' ? { dimensions: ['tool'] } : {}),
        },
      ]),
    ) as Record<Id, { run: string; inputs: unknown[]; env?: string[]; dimensions?: string[] }>,
  };
  const commit = repo.commit({
    'proof.yaml': JSON.stringify(doc),
    input: 'input',
    '.gitignore': 'stack.conf\n',
  });
  const env = {
    PROOF_STATE_DIR: join(repo.path, '.git/state'),
    PROOF_STORE,
    MODE: 'different',
    FAIL: undefined,
  };
  const cli = (args: string[], code = 0, overrides = {}) => {
    const result = repo.cli(args, { ...env, ...overrides });
    expect(result.code, result.out + result.err).toBe(code);
    return result.out;
  };
  cli(['plan']);
  const query: Query = async <T>(statement: string, ...values: (string | number | null)[]) => {
    using db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
    return db.query(statement).all(...values) as T[];
  };
  const plan = () =>
    JSON.parse(cli(['plan', '--json'])) as { task: Id; key: string; state: string }[];
  return { repo, doc, commit, env, cli, query, plan };
}
type Fixture = ReturnType<typeof fixture>;
async function seed(
  f: Fixture,
  query = f.query,
  ids: Id[] = Object.keys(released) as Id[],
  options: {
    key?: string;
    identities?: [string, string][];
    finished?: string;
    outcome?: string;
  } = {},
) {
  const results: (number | string)[] = [];
  for (const task of ids) {
    const [original, identities] = released[task];
    const key = options.key ?? original;
    const [row] = await query<{ id: number | string }>(
      `INSERT INTO results
      (project, task, key, outcome, seconds, host, "commit", dirty, finished_at)
      VALUES ('rekey', ?, ?, ?, 12, 'old-host', ?, 0, ?) RETURNING id`,
      task,
      key,
      options.outcome ?? 'green',
      f.commit,
      options.finished ?? '2026-01-01T00:00:00Z',
    );
    if (!row) throw new Error('missing fixture result');
    results.push(row.id);
    if (options.outcome === 'red') {
      await query('INSERT INTO unshared_reds VALUES (?, ?, ?, ?)', 'rekey', task, key, row.id);
      continue;
    }
    await query(
      'INSERT INTO proofs VALUES (?, ?, ?, ?, ?)',
      'rekey',
      task,
      key,
      row.id,
      JSON.stringify(options.identities ?? identities),
    );
    if (task === 'mixed' || task === 'dimension')
      await query('INSERT INTO dimension_values VALUES (?, ?, ?)', row.id, 'tool', 'demo');
  }
  return results;
}
function remoteQuery(sql: Awaited<ReturnType<Postgres['database']>>['sql']): Query {
  return async <T>(statement: string, ...values: (string | number | null)[]) => {
    let i = 0;
    return (await sql.unsafe(
      statement.replaceAll('?', () => `$${++i}`),
      values,
    )) as T[];
  };
}

test('dry run, apply and repeat carry released proofs without executing tasks or creating results', async () => {
  const f = fixture();
  Object.assign(f.doc, { providers: { service: { start: 'touch .git/executed; exit 99' } } });
  Object.assign(f.doc.tasks.env, { needs: ['service'] });
  f.repo.commit({ 'proof.yaml': JSON.stringify(f.doc) });
  await seed(f);
  const before = await f.query('SELECT * FROM results');
  const rows = await f.query('SELECT * FROM proofs');
  expect(
    f
      .plan()
      .filter((row) => row.state === 'PROVEN')
      .map((row) => row.task),
  ).toEqual(['plain', 'dimension']);
  expect(f.plan().find((row) => row.task === 'dimension')?.key).toBe(released.dimension[0]);
  expect(f.cli(['rekey'])).toContain('local: would carry 3; skipped proofs 0; unchanged 2');
  expect(await f.query('SELECT * FROM proofs')).toEqual(rows);
  expect(f.cli(['rekey', '--apply'])).toContain('local: carried 3; skipped proofs 0; unchanged 2');
  expect(f.plan().every((row) => row.state === 'PROVEN')).toBe(true);
  expect(await f.query('SELECT * FROM results')).toEqual(before);
  const carried = await f.query<{ task: Id; key: string; env_hashes: string }>(
    'SELECT * FROM proofs',
  );
  expect(carried).toHaveLength(8);
  for (const row of f.plan()) {
    const proof = carried.find((p) => p.task === row.task && p.key === row.key);
    expect(JSON.parse(proof?.env_hashes as string)).toEqual(
      row.task === 'mixed' || row.task === 'dimension' ? [['dimension:tool', toolHash]] : [],
    );
  }
  expect(f.cli(['rekey', '--apply'])).toContain('local: carried 0; skipped proofs 3; unchanged 5');
  expect(await f.query('SELECT * FROM results')).toEqual(before);
  expect(await f.query('SELECT * FROM proofs')).toEqual(carried);
  expect(existsSync(join(f.repo.path, '.git/executed'))).toBe(false);
});

test('converging env variants choose the newest result and a contested sibling vetoes all', async () => {
  for (const contested of [false, true]) {
    const f = fixture();
    const [source] = await seed(f);
    const [newest] = await seed(f, f.query, ['env'], {
      key: newerEnv,
      identities: [
        ['FAIL', 'absent'],
        ['MODE', '11507a0e2f5e69d5dfa40a62a1bd7b6ee57e6bcd85c67c9b8431b36fff21c437'],
      ],
      finished: '2026-01-02',
    });
    const [other] = await seed(f, f.query, ['env'], {
      key: 'other-tree',
      identities: [],
      finished: '2025-01-01',
    });
    await f.query('INSERT INTO observed_contests VALUES (?, ?, ?)', other as number, 'red', 'host');
    if (contested)
      await f.query(
        'INSERT INTO observed_contests VALUES (?, ?, ?)',
        source as number,
        'red',
        'host',
      );
    expect(f.cli(['rekey', '--apply'])).toContain(
      contested ? 'contested: 2' : 'already present: 1',
    );
    const row = f.plan().find((r) => r.task === 'env');
    expect(row?.state).toBe(contested ? 'RUN' : 'PROVEN');
    if (contested) continue;
    expect(await f.query('SELECT result_id FROM proofs WHERE key = ?', row?.key as string)).toEqual(
      [{ result_id: newest }],
    );
  }
});

test('refusals count proofs by reason and undecidable tasks separately', async () => {
  const cases: [string, string, Id][] = [
    ['input', 'key differs: 5', 'env'],
    ['declaration', 'key differs: 1', 'env'],
    ['missing', 'undecidable tasks 5', 'env'],
    ['dimension', 'dimensions differ: 2', 'mixed'],
    ['unavailable dimension', 'undecidable tasks 2', 'mixed'],
    ['null', 'null identities: 1', 'env'],
    ['bad key', 'key differs: 1', 'env'],
  ];
  for (const [name, reason, task] of cases) {
    const f = fixture();
    await seed(f);
    if (name === 'input') f.repo.commit({ input: 'changed' });
    else if (name === 'missing') {
      f.repo.git('rm', 'input');
      f.repo.commit({});
    } else if (['declaration', 'dimension', 'unavailable dimension'].includes(name)) {
      if (name === 'declaration') Object.assign(f.doc.tasks.env, { run: 'false' });
      if (name.includes('dimension'))
        f.doc.dimensions.tool = name === 'dimension' ? 'printf other' : 'exit 1';
      f.repo.commit({ 'proof.yaml': JSON.stringify(f.doc) });
    } else if (name === 'null')
      await f.query("UPDATE proofs SET env_hashes = NULL WHERE task IN ('env', 'plain')");
    else if (name === 'bad key')
      await f.query("UPDATE proofs SET key = 'wrong' WHERE task = 'env'");
    expect(f.cli(['rekey', '--apply']), name).toContain(reason);
    expect(f.plan().find((row) => row.task === task)?.state, name).toBe('RUN');
    if (name === 'null') expect(f.plan().find((row) => row.task === 'plain')?.state).toBe('PROVEN');
  }
}, 30_000);

test('dirty HEAD and invalid syntax refuse; unavailable store refuses both modes before any carry', async () => {
  const f = fixture();
  await seed(f);
  const before = await f.query('SELECT * FROM proofs');
  for (const path of ['input', 'untracked']) {
    f.repo.write(path, 'dirty');
    const r = f.repo.cli(['rekey', '--apply'], f.env);
    expect(r.code).toBe(2);
    expect(r.out).toBe('  dirty tree: 1\n');
    expect(r.err).toContain('requires a clean checkout');
    expect(await f.query('SELECT * FROM proofs')).toEqual(before);
    f.repo.git('reset', '--hard', 'HEAD');
    f.repo.git('clean', '-fd');
  }
  for (const args of [['--set', 'all'], ['--apply', '--apply'], ['extra']])
    f.cli(['rekey', ...args], 2);
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  for (const args of [[], ['--apply']]) {
    const result = f.repo.cli(['rekey', ...args], {
      ...f.env,
      PROOF_STORE: `postgres://proof@127.0.0.1:${port}/proof`,
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain('Postgres store');
    expect(await f.query('SELECT * FROM proofs')).toEqual(before);
  }
});

test('remote-only proofs carry on their backend and local contests veto remote carries', async () => {
  const remote = await postgres.database();
  const query = remoteQuery(remote.sql);
  const f = fixture(remote.PROOF_STORE);
  await seed(f, query);
  await seed(f, f.query, ['env']);
  await seed(f, f.query, ['env'], { outcome: 'red' });
  const before = await query('SELECT * FROM proofs ORDER BY task, key');
  expect(f.cli(['rekey'])).toContain('shared: would carry 2');
  expect(await query('SELECT * FROM proofs ORDER BY task, key')).toEqual(before);
  expect(f.cli(['rekey', '--apply'])).toContain('shared: carried 2');
  expect(
    f
      .plan()
      .filter((row) => row.state === 'RUN')
      .map((row) => row.task),
  ).toEqual(['env']);
  expect(await f.query('SELECT * FROM proofs')).toHaveLength(1);
  expect(await query('SELECT * FROM results')).toHaveLength(5);
});

test('fresh reds still reject carried proofs', async () => {
  const f = fixture();
  await seed(f);
  f.cli(['rekey', '--apply']);
  f.cli(['run', '--fresh', '--tasks', 'mixed'], 1, { FAIL: 'yes' });
  expect(f.plan().find((r) => r.task === 'mixed')?.state).toBe('RUN');
  expect(f.cli(['rekey', '--apply'])).toContain('destination rejected');
  f.cli(['run', '--fresh', '--tasks', 'mixed']);
  expect(f.plan().find((r) => r.task === 'mixed')?.state).toBe('PROVEN');
}, 30_000);

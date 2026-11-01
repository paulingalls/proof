import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { output, Postgres, waitFor } from './support/postgres';
import { isolatedEnv, Repo } from './support/repo';

let postgres: Postgres;
const repos: Repo[] = [];
const paths: string[] = [];
beforeAll(async () => {
  postgres = await new Postgres(true).start();
}, 180_000);
afterAll(async () => {
  await postgres?.close();
}, 30_000);
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'proof-stats-'));
  paths.push(path);
  return path;
}
async function setup() {
  const repo = Repo.from('stats-shared', (r) =>
    r.commit({
      'proof.yaml': JSON.stringify({
        version: 1,
        project: 'stats',
        dimensions: { platform: 'printf ios', arch: 'printf arm64' },
        tasks: {
          a: {
            run: 'exit 0',
            inputs: ['input'],
            dimensions: ['platform', 'arch'],
            env: ['STATS_SECRET'],
          },
        },
      }),
      input: 'input',
    }),
  );
  repos.push(repo);
  const { PROOF_STORE, sql } = await postgres.database();
  const env = {
    PROOF_STORE,
    PROOF_STATE_DIR: directory(),
    STATS_SECRET: 'stats-private-sentinel-394827',
  };
  return { repo, sql, env, cli: (...args: string[]) => repo.cli(args, env) };
}

test('shared skips report once across clones and offline history stays local', async () => {
  const { repo, sql, env, cli } = await setup();
  expect(cli('record', 'a', '--outcome', 'green', '--seconds', '20').code).toBe(0);
  for (let i = 0; i < 3; i++) expect(cli('run').code).toBe(0);
  using db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
  expect(db.query('SELECT project, task, day, count FROM skips').all()).toEqual(
    await sql`SELECT project, task, day, count FROM skips`,
  );
  const query = `SELECT r.outcome, d.name, d.value FROM results r
    JOIN dimension_values d ON d.result_id = r.id ORDER BY r.id, d.name`;
  expect(db.query(query).all()).toEqual(await sql.unsafe(query));
  expect(db.query(query).all()).toEqual([
    { outcome: 'green', name: 'arch', value: 'arm64' },
    { outcome: 'green', name: 'platform', value: 'ios' },
  ]);
  for (const { name } of db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all())
    expect(JSON.stringify(db.query(`SELECT * FROM "${name}"`).all())).not.toContain(
      env.STATS_SECRET,
    );
  for (const {
    tablename,
  } of await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)
    expect(JSON.stringify(await sql.unsafe(`SELECT * FROM "${tablename}"`))).not.toContain(
      env.STATS_SECRET,
    );
  const clone = new Repo(repo);
  repos.push(clone);
  const shared = clone.cli(['stats'], { ...env, PROOF_STATE_DIR: directory() });
  expect(shared).toEqual({
    code: 0,
    err: '',
    out: 'a: median 20s; 1 runs in 30d\nestimated 0m for 0 RUN tasks\nsaved 1m of 1.33m in 30d (75%); previous 30d: unavailable\n',
  });
  const report = (r: Repo, state: string) =>
    r.cli(['stats', '--by', 'platform', '--json'], { ...env, PROOF_STATE_DIR: state });
  const online = JSON.parse(report(clone, directory()).out);
  expect(online.tasks[0].split.values).toEqual([{ value: 'ios', median: 20, runs: 1 }]);
  postgres.stop();
  try {
    expect(cli('record', 'a', '--outcome', 'green', '--seconds', '100').code).toBe(0);
    const run = cli('run');
    expect(run.code).toBe(0);
    expect(run.err).toContain('store unreachable');
    const split = report(repo, env.PROOF_STATE_DIR);
    expect(split.err).toContain('store unreachable');
    expect(JSON.parse(split.out).tasks[0].split.values).toEqual([
      { value: 'ios', median: 60, runs: 2 },
    ]);
    const offline = cli('stats');
    expect(offline.code).toBe(0);
    expect(offline.err).toContain("using this machine's own proofs");
    expect(offline.out).toBe(
      'a: median 60s; 2 runs in 30d\nestimated 0m for 0 RUN tasks\nsaved 4m of 6m in 30d (66.67%); previous 30d: unavailable\n',
    );
  } finally {
    await postgres.restart();
  }
  expect(cli('stats')).toEqual(shared);
  expect(JSON.parse(report(repo, env.PROOF_STATE_DIR).out)).toEqual(online);
  expect(await sql`SELECT count FROM skips`).toEqual([{ count: 3 }]);
}, 30_000);

test('a lost remote skip write keeps the local increment and task exit without replay', async () => {
  const { repo, sql, env, cli } = await setup();
  const ready = join(directory(), 'ready');
  const release = join(directory(), 'release');
  repo.commit({
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'stats',
      tasks: {
        a: { run: 'exit 0', inputs: ['input'] },
        wait: {
          run: `touch ${ready}; while ! test -e ${release}; do sleep 0.02; done; exit 7`,
          inputs: ['missing/**'],
        },
      },
    }),
  });
  expect(cli('record', 'a', '--outcome', 'green').code).toBe(0);
  const child = repo.spawnCli(['run'], env);
  const done = output(child);
  const deadline = setTimeout(() => child.kill('SIGKILL'), 20_000);
  let stopped = false;
  try {
    await waitFor(async () => existsSync(ready));
    postgres.stop();
    stopped = true;
    writeFileSync(release, 'go');
    const result = await done;
    expect(result.code).toBe(1);
    expect(result.out).toContain('not recorded:');
    expect(result.err).toContain('store unreachable');
    using db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
    expect(db.query('SELECT task, count FROM skips').all()).toEqual([{ task: 'a', count: 1 }]);
  } finally {
    clearTimeout(deadline);
    child.kill();
    await child.exited;
    if (stopped) await postgres.restart();
  }
  expect(cli('stats').code).toBe(0);
  expect(await sql`SELECT * FROM skips`).toEqual([]);
}, 30_000);

test('v0.14.1 stores remain schema 2 and both real clients preserve proof and skips', async () => {
  const { repo, sql, env, cli } = await setup();
  const oldCli = new URL('../node_modules/proof-last/src/cli.ts', import.meta.url).pathname;
  const old = (...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, '--no-env-file', oldCli, ...args], {
      cwd: repo.path,
      env: { ...isolatedEnv(), HOME: undefined, XDG_CONFIG_HOME: undefined, ...env },
    });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  expect(old('--version').trim()).toBe('0.14.1');
  old('record', 'a', '--outcome', 'green', '--seconds', '20');
  expect(await sql`SELECT tablename FROM pg_tables WHERE tablename = 'dimension_values'`).toEqual(
    [],
  );
  using legacy = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
  expect(
    legacy.query("SELECT name FROM sqlite_master WHERE name = 'dimension_values'").all(),
  ).toEqual([]);
  const before = await sql`SELECT key, env_hashes FROM proofs`;
  expect(cli('record', 'a', '--outcome', 'green', '--seconds', '20').code).toBe(0);
  expect(await sql`SELECT key, env_hashes FROM proofs`).toEqual(before);
  expect(await sql`SELECT name, value FROM dimension_values ORDER BY name`).toEqual([
    { name: 'arch', value: 'arm64' },
    { name: 'platform', value: 'ios' },
  ]);
  expect(cli('run').out).toContain('PROVEN a');
  expect(cli('stats').out).toContain('saved 0.33m of 1m');
  expect(old('plan')).toContain('PROVEN a');
  old('record', 'a', '--outcome', 'green', '--seconds', '40');
  expect(cli('stats').out).toContain('a: median 20s; 3 runs');
  using db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
  for (const query of [
    'SELECT version FROM schema_version',
    'SELECT task, count FROM skips',
    'SELECT key, env_hashes FROM proofs',
    'SELECT name, value FROM dimension_values ORDER BY name',
    'SELECT outcome, seconds FROM results ORDER BY id',
  ])
    expect(db.query(query).all()).toEqual(await sql.unsafe(query));
  expect(JSON.parse(cli('stats', '--by', 'platform', '--json').out).tasks[0].split.values).toEqual([
    { value: 'ios', median: 20, runs: 1 },
    { value: null, median: 30, runs: 2 },
  ]);
  expect(await sql`SELECT version FROM schema_version`).toEqual([{ version: 2 }]);
  expect(await sql`SELECT task, count FROM skips`).toEqual([{ task: 'a', count: 1 }]);
}, 30_000);

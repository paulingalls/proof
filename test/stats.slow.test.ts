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
        tasks: {
          a: { run: 'exit 0', inputs: ['input'] },
        },
      }),
      input: 'input',
    }),
  );
  repos.push(repo);
  const { PROOF_STORE, sql } = await postgres.database();
  const env = { PROOF_STORE, PROOF_STATE_DIR: directory() };
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
  const clone = new Repo(repo);
  repos.push(clone);
  const shared = clone.cli(['stats'], { ...env, PROOF_STATE_DIR: directory() });
  expect(shared).toEqual({
    code: 0,
    err: '',
    out: 'a: median 20s; 1 runs in 30d\nestimated 0m for 0 RUN tasks\nsaved 1m of 1.33m in 30d (75%); previous 30d: unavailable\n',
  });
  postgres.stop();
  try {
    expect(cli('record', 'a', '--outcome', 'green', '--seconds', '100').code).toBe(0);
    const run = cli('run');
    expect(run.code).toBe(0);
    expect(run.err).toContain('store unreachable');
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

test('v0.10.0 stores remain schema 2 and both real clients preserve proof and skips', async () => {
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
  expect(old('--version').trim()).toBe('0.10.0');
  old('record', 'a', '--outcome', 'green', '--seconds', '20');
  expect(cli('run').out).toContain('PROVEN a');
  expect(cli('stats').out).toContain('saved 0.33m of 0.67m');
  expect(old('plan')).toContain('PROVEN a');
  old('record', 'a', '--outcome', 'green', '--seconds', '40');
  expect(cli('stats').out).toContain('a: median 30s; 2 runs');
  using db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
  for (const query of [
    'SELECT version FROM schema_version',
    'SELECT task, count FROM skips',
    'SELECT outcome, seconds FROM results ORDER BY id',
  ])
    expect(db.query(query).all()).toEqual(await sql.unsafe(query));
  expect(await sql`SELECT version FROM schema_version`).toEqual([{ version: 2 }]);
  expect(await sql`SELECT task, count FROM skips`).toEqual([{ task: 'a', count: 1 }]);
}, 30_000);

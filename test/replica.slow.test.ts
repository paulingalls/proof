import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { output, Postgres } from './support/postgres';
import { Repo } from './support/repo';

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
function state() {
  const path = mkdtempSync(join(tmpdir(), 'proof-replica-'));
  paths.push(path);
  return path;
}
async function setup() {
  const repo = Repo.from('replica', (r) =>
    r.commit({
      'proof.yaml': JSON.stringify({
        version: 1,
        project: 'example',
        tasks: {
          lint: { run: 'echo executed-lint', inputs: ['src/**'] },
          check: { run: 'echo executed-check', inputs: ['src/**'] },
        },
      }),
      'src/a.ts': 'a',
    }),
  );
  const clone = new Repo(repo);
  repos.push(repo, clone);
  const { PROOF_STORE, sql } = await postgres.database();
  const a = { PROOF_STORE, PROOF_STATE_DIR: state() };
  const b = { PROOF_STORE, PROOF_STATE_DIR: state() };
  const record = (outcome: string, env = a, task = 'lint') => {
    const result = repo.cli(['record', task, '--outcome', outcome], env);
    expect(result.code).toBe(0);
    return result;
  };
  const rows = (query = 'SELECT outcome FROM results ORDER BY id') => {
    const db = new Database(join(a.PROOF_STATE_DIR, 'proof.db'), { readonly: true });
    try {
      return db.query(query).all();
    } finally {
      db.close();
    }
  };
  return { repo, clone, a, b, sql, record, rows };
}
function fallback(result: { code: number; err: string }) {
  expect(result.code).toBe(0);
  expect(result.err.trim()).toMatch(/^store unreachable \(.+\); using this machine's own proofs$/);
}

test('online record and run survive an outage without importing another machine’s history', async () => {
  const { repo, clone, a, b, sql, record, rows } = await setup();
  record('green');
  expect(repo.cli(['run', '--tasks', 'check'], a).code).toBe(0);
  expect(clone.cli(['plan'], b).out.match(/PROVEN/g)).toHaveLength(2);
  expect(
    rows('SELECT task, outcome, host, "commit", finished_at FROM results ORDER BY id'),
  ).toEqual(await sql`SELECT task, outcome, host, "commit", finished_at FROM results ORDER BY id`);
  postgres.stop();
  try {
    const result = repo.cli(['plan'], a);
    fallback(result);
    expect(result.out).toContain(
      `PROVEN lint: proven at ${repo.git('rev-parse', 'HEAD')} on ${hostname()}`,
    );
    const json = repo.cli(['plan', '--json'], a);
    fallback(json);
    expect(JSON.parse(json.out).map((r: { state: string }) => r.state)).toEqual([
      'PROVEN',
      'PROVEN',
    ]);
    const other = clone.cli(['plan'], b);
    fallback(other);
    expect(other.out).not.toContain('PROVEN');
  } finally {
    await postgres.restart();
  }
}, 30_000);

test('offline results stay local across reopen and online reads never merge local greens', async () => {
  const { repo, clone, a, b, sql, record, rows } = await setup();
  expect(repo.cli(['plan'], a).code).toBe(0);
  postgres.stop();
  try {
    const run = repo.cli(['run', '--tasks', 'lint'], a);
    fallback(run);
    expect(run.out).toContain('executed-lint');
    expect(run.out).toContain('not shared');
    expect(record('green', a, 'check').out).toContain('not shared');
    record('incomplete');
    repo.write('src/a.ts', 'dirty');
    expect(record('green').out).toContain('no proof published');
    repo.git('restore', '.');
    expect(rows()).toEqual([
      { outcome: 'green' },
      { outcome: 'green' },
      { outcome: 'incomplete' },
      { outcome: 'green' },
    ]);
    expect(repo.cli(['plan'], a).out.match(/PROVEN/g)).toHaveLength(2);
  } finally {
    await postgres.restart();
  }
  for (const [target, env] of [
    [repo, a],
    [clone, a],
    [clone, b],
  ] as const) {
    const result = target.cli(['plan'], env);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain('PROVEN');
  }
  expect(await sql`SELECT * FROM results`).toHaveLength(0);
  postgres.stop();
  try {
    expect(repo.cli(['plan'], a).out.match(/PROVEN/g)).toHaveLength(2);
  } finally {
    await postgres.restart();
  }
  repo.commit({
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'example',
      tasks: {
        pass: { run: 'exit 0', inputs: ['src/**'] },
        fail: { run: 'exit 7', inputs: ['src/**'] },
      },
    }),
  });
  postgres.stop();
  try {
    const failed = repo.cli(['run'], a);
    expect(failed.code).toBe(1);
    expect(failed.out.match(/not shared/g)).toHaveLength(2);
    expect(rows().slice(-2)).toEqual([{ outcome: 'green' }, { outcome: 'red' }]);
  } finally {
    await postgres.restart();
  }
}, 30_000);

test('a stalled handshake falls back once within five seconds for all tasks', async () => {
  const { repo, a } = await setup();
  const endpoint = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const started = performance.now();
  const child = repo.spawnCli(['plan'], {
    ...a,
    PROOF_STORE: `postgres://postgres:secret@127.0.0.1:${endpoint.port}/postgres`,
  });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 4900);
  try {
    const result = await output(child);
    fallback(result);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(result.out.match(/RUN/g)).toHaveLength(2);
  } finally {
    clearTimeout(deadline);
    child.kill();
    await child.exited;
    endpoint.stop(true);
  }
}, 10_000);

test('without a remote configured the local lifecycle has no sharing diagnostics', async () => {
  const { repo, a } = await setup();
  const env = { PROOF_STATE_DIR: a.PROOF_STATE_DIR };
  for (const args of [['plan'], ['record', 'lint', '--outcome', 'green'], ['run']]) {
    const result = repo.cli(args, env);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).not.toMatch(/replica|store|shared|sharing/);
  }
  expect(repo.cli(['plan'], env).out.match(/PROVEN/g)).toHaveLength(2);
});

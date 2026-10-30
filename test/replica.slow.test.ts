import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Postgres } from './support/postgres';
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

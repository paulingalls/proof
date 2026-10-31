import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Postgres } from './support/postgres';
import { Repo } from './support/repo';

const postgres = new Postgres();
const repos: Repo[] = [];
const states: string[] = [];
beforeAll(async () => {
  await postgres.start();
}, 60_000);
afterAll(async () => {
  await postgres.close();
});
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const path of states.splice(0)) rmSync(path, { recursive: true, force: true });
});
function state() {
  const path = mkdtempSync(join(tmpdir(), 'proof-why-pg-'));
  states.push(path);
  return path;
}
function fixture() {
  const repo = new Repo();
  repos.push(repo);
  repo.commit({
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'why-remote',
      tasks: {
        gate: { run: 'true', inputs: ['src/**'], env: ['PROOF_WHY_MODE'] },
        other: { run: 'true', inputs: ['src/**'] },
      },
    }),
    'src/a': 'one',
    'src/b': 'two',
  });
  return repo;
}
function changes(out: string) {
  return out.split('\n').filter((line) => /^(added|removed|changed) /.test(line));
}

test('newest remote proof crosses clone/key boundaries without importing remote history', async () => {
  const { sql, PROOF_STORE } = await postgres.database();
  const repo = fixture();
  const oldest = repo.git('rev-parse', 'HEAD');
  const env = { PROOF_STORE, PROOF_STATE_DIR: state(), PROOF_WHY_MODE: 'remote-private-original' };
  expect(repo.cli(['record', 'gate', '--outcome', 'green'], env).code).toBe(0);
  const newest = repo.commit({ 'src/a': 'new' });
  expect(repo.cli(['run', '--tasks', 'gate'], env).code).toBe(0);
  expect(repo.cli(['record', 'gate', '--outcome', 'red'], env).code).toBe(0);
  expect(repo.cli(['record', 'other', '--outcome', 'green'], env).code).toBe(0);
  const doc = JSON.parse(repo.git('show', 'HEAD:proof.yaml'));
  doc.project = 'another-project';
  repo.commit({ 'proof.yaml': JSON.stringify(doc) });
  expect(repo.cli(['record', 'gate', '--outcome', 'green'], env).code).toBe(0);
  repo.git('reset', '--hard', newest);
  const clone = new Repo(repo);
  repos.push(clone);
  clone.commit({ 'src/b': 'later' });
  expect(clone.cli(['record', 'gate', '--outcome', 'incomplete'], env).code).toBe(0);
  const reader = { ...env, PROOF_STATE_DIR: state(), PROOF_WHY_MODE: 'remote-private-new' };
  await sql`UPDATE results SET finished_at = '2026-01-01T00:00:00.000Z'`;
  await sql`UPDATE results SET finished_at = '2026-01-02T00:00:00.000Z'
    WHERE "commit" = ${oldest}`;
  const byFinishTime = clone.cli(['why', 'gate'], reader);
  expect(byFinishTime.code).toBe(0);
  expect(byFinishTime.out).toContain(`comparison: ${oldest} on `);
  expect(changes(byFinishTime.out)).toEqual([
    'changed file src/a',
    'changed file src/b',
    'changed env PROOF_WHY_MODE',
  ]);
  expect(byFinishTime.out + byFinishTime.err).not.toContain('remote-private');
  await sql`UPDATE results SET finished_at = '2026-01-01T00:00:00.000Z'`;
  const result = clone.cli(['why', 'gate'], reader);
  expect(result.code).toBe(0);
  expect(result.out).toContain(`comparison: ${newest} on `);
  expect(changes(result.out)).toEqual(['changed file src/b', 'changed env PROOF_WHY_MODE']);
  expect(result.out + result.err).not.toContain('remote-private');
  const rows =
    await sql`SELECT env_hashes FROM proofs WHERE task = 'gate' AND project = 'why-remote'`;
  const expected = JSON.stringify([
    ['PROOF_WHY_MODE', new Bun.CryptoHasher('sha256').update(env.PROOF_WHY_MODE).digest('hex')],
  ]);
  expect(rows.map((row: { env_hashes: string }) => row.env_hashes)).toEqual([expected, expected]);
  const publisher = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
  const replica = new Database(join(reader.PROOF_STATE_DIR, 'proof.db'));
  try {
    expect(
      publisher
        .query("SELECT env_hashes FROM proofs WHERE task = 'gate' AND project = 'why-remote'")
        .all(),
    ).toEqual([{ env_hashes: expected }, { env_hashes: expected }]);
    expect(replica.query('SELECT * FROM proofs').all()).toEqual([]);
    expect(replica.query('SELECT * FROM results').all()).toEqual([]);
  } finally {
    publisher.close();
    replica.close();
  }
  expect(readFileSync(join(env.PROOF_STATE_DIR, 'proof.db')).includes('remote-private')).toBe(
    false,
  );
}, 30_000);

test('remote and replica schema-one proofs migrate preserving files and unavailable env', async () => {
  const { sql, PROOF_STORE } = await postgres.database();
  const repo = fixture();
  const env = { PROOF_STORE, PROOF_STATE_DIR: state(), PROOF_WHY_MODE: 'private' };
  expect(repo.cli(['record', 'gate', '--outcome', 'green'], env).code).toBe(0);
  await sql`ALTER TABLE proofs DROP COLUMN env_hashes`;
  await sql`UPDATE schema_version SET version = 1`;
  const db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
  try {
    db.exec('ALTER TABLE proofs DROP COLUMN env_hashes; UPDATE schema_version SET version = 1');
    repo.commit({ 'src/a': 'changed' });
    const result = repo.cli(['why', 'gate'], env);
    expect(result.code).toBe(0);
    expect(result.out).toContain('env comparison unavailable');
    expect(changes(result.out)).toEqual(['changed file src/a']);
    expect(await sql`SELECT version FROM schema_version`).toEqual([{ version: 2 }]);
    expect(db.query('SELECT version FROM schema_version').all()).toEqual([{ version: 2 }]);
    expect(await sql`SELECT env_hashes FROM proofs`).toEqual([{ env_hashes: null }]);
    expect(db.query('SELECT env_hashes FROM proofs').all()).toEqual([{ env_hashes: null }]);
  } finally {
    db.close();
  }
}, 30_000);

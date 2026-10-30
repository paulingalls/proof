import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Postgres } from './support/postgres';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const dirs: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'proof-doctor-'));
  dirs.push(path);
  return path;
}
function fixture() {
  const repo = Repo.from('doctor', (r) =>
    r.commit({
      'proof.yaml': JSON.stringify({
        version: 1,
        project: 'doctor-example',
        tasks: {
          lint: { run: 'exit 0', inputs: ['src/**'] },
        },
      }),
      'src/a.ts': 'a',
    }),
  );
  repos.push(repo);
  return repo;
}
function report(out: string, store: string, state: string) {
  const lines = out.trim().split('\n');
  for (const line of [
    `Store: ${store}`,
    'Reachability: reachable',
    'Schema version: 1',
    `Replica: ${join(state, 'proof.db')}`,
    'Project: doctor-example',
    `Bun: ${Bun.version}`,
  ])
    expect(lines).toContain(line);
}
afterAll(() => {
  for (const repo of repos) repo.close();
  for (const path of dirs) rmSync(path, { recursive: true, force: true });
});

test('doctor reports local SQLite and rejects arguments', () => {
  const repo = fixture();
  const state = directory();
  const result = repo.cli(['doctor'], { PROOF_STATE_DIR: state });
  expect(result.code).toBe(0);
  expect(result.err).toBe('');
  report(result.out, join(state, 'proof.db'), state);
  const extra = repo.cli(['doctor', 'extra']);
  expect(extra.code).toBe(2);
  expect(extra.err.trim()).toBe('proof: usage: proof doctor');
});

const postgres = new Postgres(true);
afterAll(async () => postgres.close());
test('doctor checks the configured store, config file, schema and authentication', async () => {
  await postgres.start();
  const repo = fixture();
  const { PROOF_STORE, sql } = await postgres.database();
  const state = directory();
  const env = { PROOF_STORE, PROOF_STATE_DIR: state };
  const endpoint = `postgres://${new URL(PROOF_STORE).host}`;
  const result = repo.cli(['doctor'], env);
  expect(result.code).toBe(0);
  report(result.out, endpoint, state);
  expect(result.err).toBe('');
  expect(result.out + result.err).not.toContain('proof-test');
  const config = directory();
  mkdirSync(join(config, 'proof'));
  writeFileSync(join(config, 'proof/store'), `${PROOF_STORE}\n`);
  report(
    repo.cli(['doctor'], { XDG_CONFIG_HOME: config, PROOF_STATE_DIR: state }).out,
    endpoint,
    state,
  );
  expect(repo.cli(['record', 'lint', '--outcome', 'green'], env).code).toBe(0);
  await sql`UPDATE schema_version SET version = 2`;
  const schema = repo.cli(['doctor'], env);
  expect(schema.code).toBe(2);
  expect(schema.err).toContain('store schema version 2; supported version 1');
  expect(schema.out).toBe('');
  const wrong = new URL(PROOF_STORE);
  wrong.password = 'wrong-password';
  const auth = repo.cli(['doctor'], { ...env, PROOF_STORE: wrong.href });
  expect(auth.code).toBe(2);
  expect(auth.err).toContain('password authentication failed');
  expect(auth.err).not.toContain('wrong-password');
}, 60_000);

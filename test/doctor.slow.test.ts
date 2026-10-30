import { afterAll, beforeAll, expect, test } from 'bun:test';
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
beforeAll(async () => {
  await postgres.start();
}, 60_000);
afterAll(async () => postgres.close());
test('doctor checks the configured store and config file', async () => {
  const repo = fixture();
  const { PROOF_STORE } = await postgres.database();
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
  const configured = repo.cli(['doctor'], { XDG_CONFIG_HOME: config, PROOF_STATE_DIR: state });
  expect(configured.code).toBe(0);
  expect(configured.err).toBe('');
  report(configured.out, endpoint, state);
}, 30_000);

for (const failure of ['schema', 'authentication', 'query']) {
  test(`doctor keeps ${failure} errors loud with a usable replica`, async () => {
    const repo = fixture();
    const { PROOF_STORE, sql } = await postgres.database();
    const env = { PROOF_STORE, PROOF_STATE_DIR: directory() };
    expect(repo.cli(['record', 'lint', '--outcome', 'green'], env).code).toBe(0);
    let expected = 'store schema version 2; supported version 1';
    if (failure === 'schema') await sql`UPDATE schema_version SET version = 2`;
    else if (failure === 'query') {
      await sql`ALTER TABLE schema_version RENAME COLUMN version TO missing_version`;
      expected = 'column "version" does not exist';
    } else {
      const wrong = new URL(PROOF_STORE);
      wrong.password = 'wrong-password';
      env.PROOF_STORE = wrong.href;
      expected = 'password authentication failed';
    }
    const result = repo.cli(['doctor'], env);
    expect(result.code).toBe(2);
    expect(result.err).toContain(expected);
    expect(result.err).not.toContain('wrong-password');
    expect(result.err).not.toContain('using this machine');
    expect(result.out).toBe('');
  }, 30_000);
}

test('doctor reports an outage even with a populated replica', async () => {
  const repo = fixture();
  const { PROOF_STORE } = await postgres.database();
  const state = directory();
  const env = { PROOF_STORE, PROOF_STATE_DIR: state };
  expect(repo.cli(['record', 'lint', '--outcome', 'green'], env).code).toBe(0);
  expect(repo.cli(['doctor'], env).code).toBe(0);
  postgres.stop();
  try {
    const result = repo.cli(['doctor'], env);
    expect(result.code).toBe(1);
    const lines = result.out.trim().split('\n');
    expect(lines).toContain(`Store: postgres://${new URL(PROOF_STORE).host}`);
    expect(lines).toContain('Schema version: unavailable');
    expect(lines).toContain(`Replica: ${join(state, 'proof.db')}`);
    expect(lines).toContain('Project: doctor-example');
    expect(lines).toContain(`Bun: ${Bun.version}`);
    expect(lines.some((line) => /^Reachability: unreachable \(.+\)$/.test(line))).toBe(true);
    expect(lines).not.toContain('Reachability: reachable');
    expect(result.out + result.err).not.toContain('proof-test');
    expect(result.err).toBe('');
  } finally {
    await postgres.restart();
  }
}, 30_000);

test('the operator guide startup block accepts doctor and cleans its named volume', async () => {
  const source = await Bun.file(new URL('../docs/store.md', import.meta.url)).text();
  const block = source.match(
    /<!-- proof-start -->\s*```sh\n([\s\S]*?)```\s*<!-- proof-end -->/,
  )?.[1];
  expect(block).toBeDefined();
  if (!block) throw new Error('missing operator startup block');
  const scratch = new Postgres();
  try {
    await scratch.startGuide(block);
    const state = directory();
    const result = fixture().cli(['doctor'], { PROOF_STORE: scratch.url, PROOF_STATE_DIR: state });
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    report(result.out, `postgres://${new URL(scratch.url).host}`, state);
  } finally {
    await scratch.close();
    scratch.assertAbsent();
  }
}, 60_000);

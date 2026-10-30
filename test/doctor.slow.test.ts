import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
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

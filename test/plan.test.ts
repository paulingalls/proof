import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const states: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const state of states.splice(0)) rmSync(state, { recursive: true, force: true });
});
function fixture(project = 'example') {
  const repo = new Repo();
  repos.push(repo);
  repo.commit({
    'proof.yaml': JSON.stringify({
      version: 1,
      project,
      tasks: {
        lint: { run: 'exit 99', inputs: ['src/**'] },
        'docs-check': { run: 'exit 99', inputs: ['docs/guide/**'] },
      },
    }),
    'src/a.ts': 'a',
    'docs/guide/start.md': 'guide',
  });
  return repo;
}
function state() {
  const path = mkdtempSync(join(tmpdir(), 'proof-state-'));
  states.push(path);
  return { PROOF_STATE_DIR: path };
}

test('empty store plans every declared task with its reason', () => {
  const result = fixture().cli(['plan'], state());
  expect(result).toEqual({
    code: 0,
    err: '',
    out: 'RUN lint: no proof for key\nRUN docs-check: no proof for key\n',
  });
});

import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
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

function record(repo: Repo, env: Record<string, string>, seconds = ['--seconds', '3']) {
  return repo.cli(['record', 'lint', '--outcome', 'green', ...seconds], env);
}

test('clean greens publish scoped proof reused by another clone', () => {
  const repo = fixture();
  const env = state();
  expect(record(repo, env).code).toBe(0);
  const clone = new Repo(repo);
  repos.push(clone);
  const result = clone.cli(['plan'], env);
  expect(result.code).toBe(0);
  expect(result.out).toContain(
    `PROVEN lint: proven at ${repo.git('rev-parse', 'HEAD')} on ${hostname()} `,
  );
  expect(result.out).toContain('RUN docs-check: no proof for key');
  const db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
  expect(db.query('SELECT outcome, seconds, dirty FROM results').all()).toEqual([
    { outcome: 'green', seconds: 3, dirty: 0 },
  ]);
  expect(db.query('SELECT result_id FROM proofs').all()).toEqual([{ result_id: 1 }]);
  db.close();
  expect(fixture('other').cli(['plan'], env).out).toContain('RUN lint: no proof for key');
});

test('store uses XDG state or HOME when no explicit directory is supplied', () => {
  const repo = fixture();
  for (const name of ['XDG_STATE_HOME', 'HOME']) {
    const base = state().PROOF_STATE_DIR;
    const env = { [name]: base };
    expect(record(repo, env).code).toBe(0);
    expect(repo.cli(['plan'], env).out).toContain('PROVEN lint');
    expect(
      Bun.file(join(base, name === 'HOME' ? '.local/state/proof/proof.db' : 'proof/proof.db')).size,
    ).toBeGreaterThan(0);
  }
});

test('plan gates selected dirty inputs but ignores unrelated files and tags', () => {
  const repo = fixture();
  const doc = JSON.parse(repo.git('show', 'HEAD:proof.yaml'));
  doc.tasks.lint.inputs = ['src/**', '!src/gen/**', 'src/gen/keep.ts'];
  repo.commit({
    'proof.yaml': JSON.stringify(doc),
    'src/c d.ts': 'space',
    'src/gen/x.ts': 'excluded',
    'src/gen/keep.ts': 'included',
  });
  const env = state();
  expect(record(repo, env).code).toBe(0);
  repo.write('notes/todo.md', 'todo');
  expect(repo.cli(['plan'], env).out).toContain('PROVEN lint');
  repo.git('tag', 'release');
  expect(repo.cli(['plan'], env).out).toContain('PROVEN lint');
  repo.write('src/gen/x.ts', 'changed');
  expect(repo.cli(['plan'], env).out).toContain('PROVEN lint');
  repo.git('restore', '.');
  for (const [path, stage, remove] of [
    ['src/a.ts', false, false],
    ['src/a.ts', true, false],
    ['src/b.ts', false, false],
    ['src/c d.ts', false, true],
    ['src/gen/keep.ts', false, false],
  ] as const) {
    if (remove) rmSync(join(repo.path, path));
    else repo.write(path, 'changed');
    if (stage) repo.git('add', path);
    const result = repo.cli(['plan'], env);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`RUN lint: undecidable: dirty input '${path}'`);
    expect(result.out).toContain('RUN docs-check: no proof for key');
    repo.git('reset', '--hard', 'HEAD');
    if (path === 'src/b.ts') rmSync(join(repo.path, path));
  }
});

test('restored historical bytes are undecidable until committed', () => {
  const repo = fixture();
  const env = state();
  expect(record(repo, env).code).toBe(0);
  repo.commit({ 'src/a.ts': 'b' });
  expect(repo.cli(['plan'], env).out).toContain('RUN lint: no proof for key');
  repo.write('src/a.ts', 'a');
  expect(repo.cli(['plan'], env).out).toContain("RUN lint: undecidable: dirty input 'src/a.ts'");
});

import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyDir, Repo } from './support/repo';

const repos: Repo[] = [];
const states: string[] = [];
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const repo of repos.splice(0)) repo.close();
  for (const path of states.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture(project = 'example') {
  const repo = Repo.from(`contested:${project}`, (template) =>
    template.commit({
      'proof.yaml': JSON.stringify({
        version: 1,
        project,
        tasks: { lint: { run: 'exit 99', inputs: ['src/**'] } },
      }),
      'src/a.ts': 'a',
    }),
  );
  repos.push(repo);
  return repo;
}
// The recorded store is built once per shape too; clones share the fixture's commit, so its
// proofs hold for every copy.
const stores = new Map<string, string>();
process.on('exit', () => {
  for (const path of stores.values()) rmSync(path, { recursive: true, force: true });
});
function setup(other?: Repo) {
  const repo = fixture();
  const shape = other ? 'other' : 'solo';
  function record(outcome: string, target = repo, task = 'lint') {
    const result = target.cli(['record', task, '--outcome', outcome], env);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`recorded ${outcome} ${task}`);
    return result;
  }
  let template = stores.get(shape);
  let env = { PROOF_STATE_DIR: '' };
  if (!template) {
    template = mkdtempSync(join(tmpdir(), 'proof-state-'));
    env = { PROOF_STATE_DIR: template };
    if (other) record('green', other);
    record('green');
    stores.set(shape, template);
  }
  const path = copyDir(template, 'proof-state-');
  states.push(path);
  env = { PROOF_STATE_DIR: path };
  const db = new Database(join(path, 'proof.db'));
  databases.push(db);
  function plan(expected: string, target = repo) {
    const result = target.cli(['plan'], env);
    expect(result.code).toBe(0);
    expect(result.out).toContain(expected);
  }
  const proof = () => db.query("SELECT result_id FROM proofs WHERE project = 'example'").all();
  const contradictions = () =>
    db
      .query(`SELECT green_result, red_result, kind, deleted_proof FROM contradictions
      WHERE project = 'example' ORDER BY id`)
      .all();
  return { repo, env, db, record, plan, proof, contradictions };
}

test('first red retains and contests only its project proof with red provenance', () => {
  const other = fixture('other');
  const { repo, record, plan, proof, contradictions, db } = setup(other);
  const commit = repo.commit({ 'notes.md': 'unrelated' });
  record('red');
  expect(db.query('SELECT outcome FROM results ORDER BY id').all()).toEqual([
    { outcome: 'green' },
    { outcome: 'green' },
    { outcome: 'red' },
  ]);
  expect(proof()).toEqual([{ result_id: 2 }]);
  expect(contradictions()).toEqual([
    { green_result: 2, red_result: 3, kind: 'ordinary', deleted_proof: 0 },
  ]);
  plan(`RUN lint: contested: red at ${commit} on ${hostname()} after green\n`);
  plan('PROVEN lint', other);
});

test('green settles a contest and the next red contests the new green anchor', () => {
  const { record, plan, proof, contradictions } = setup();
  record('red');
  record('green');
  plan('PROVEN lint');
  expect(proof()).toEqual([{ result_id: 3 }]);
  expect(contradictions()).toHaveLength(1);
  record('red');
  plan('RUN lint: contested:');
  expect(proof()).toEqual([{ result_id: 3 }]);
  expect(contradictions()).toEqual([
    { green_result: 1, red_result: 2, kind: 'ordinary', deleted_proof: 0 },
    { green_result: 3, red_result: 4, kind: 'ordinary', deleted_proof: 0 },
  ]);
});

test('incomplete stores history and preserves an uncontested proof', () => {
  const { record, plan, proof, contradictions, db } = setup();
  record('incomplete');
  expect(db.query('SELECT outcome FROM results WHERE id = 2').get()).toEqual({
    outcome: 'incomplete',
  });
  expect(proof()).toEqual([{ result_id: 1 }]);
  expect(contradictions()).toEqual([]);
  plan('PROVEN lint');
});

test('invalid outcomes and undeclared tasks name the rejected value without storing a result', () => {
  const { repo, env, db } = setup();
  for (const [task, outcome, name] of [
    ['lint', 'purple', 'purple'],
    ['absent', 'green', 'absent'],
  ] as const) {
    const result = repo.cli(['record', task, '--outcome', outcome], env);
    expect(result.code).toBe(2);
    expect(result.err).toContain(name);
    expect(db.query('SELECT id FROM results').all()).toEqual([{ id: 1 }]);
  }
});

test('second red deletes the proof despite intervening incomplete, then green restores it', () => {
  const other = fixture('other');
  const { record, plan, proof, contradictions, db } = setup(other);
  record('red');
  record('incomplete');
  plan('RUN lint: contested:');
  expect(proof()).toEqual([{ result_id: 2 }]);
  record('red');
  expect(proof()).toEqual([]);
  expect(contradictions()).toEqual([
    { green_result: 2, red_result: 3, kind: 'ordinary', deleted_proof: 0 },
    { green_result: 2, red_result: 5, kind: 'ordinary', deleted_proof: 1 },
  ]);
  plan('RUN lint: no proof for key');
  plan('PROVEN lint', other);
  record('red');
  expect(contradictions()).toHaveLength(2);
  expect(db.query("SELECT id FROM results WHERE outcome = 'red' ORDER BY id").all()).toEqual([
    { id: 3 },
    { id: 5 },
    { id: 6 },
  ]);
  record('green');
  plan('PROVEN lint');
});

test('dirty input reds store history only; unrelated dirtiness still contests and deletes', () => {
  const { repo, record, plan, proof, contradictions, db } = setup();
  repo.write('src/a.ts', 'dirty input');
  expect(record('red').out).toContain("contests nothing: dirty input 'src/a.ts'");
  record('red');
  expect(proof()).toEqual([{ result_id: 1 }]);
  expect(contradictions()).toEqual([]);
  repo.git('restore', '.');
  plan('PROVEN lint');
  repo.write('notes.md', 'unrelated dirtiness');
  record('red');
  plan('RUN lint: contested:');
  expect(proof()).toEqual([{ result_id: 1 }]);
  record('red');
  expect(proof()).toEqual([]);
  expect(contradictions()).toEqual([
    { green_result: 1, red_result: 4, kind: 'ordinary', deleted_proof: 0 },
    { green_result: 1, red_result: 5, kind: 'ordinary', deleted_proof: 1 },
  ]);
  expect(db.query('SELECT outcome, dirty FROM results WHERE id > 1').all()).toEqual(
    Array.from({ length: 4 }, () => ({ outcome: 'red', dirty: 1 })),
  );
  plan('RUN lint: no proof for key');
});

test('a red under a dirty declaration contests nothing', () => {
  const { repo, record, plan, proof, contradictions } = setup();
  repo.write(
    'proof.yaml',
    JSON.stringify({
      version: 1,
      project: 'example',
      tasks: { lint: { run: 'exit 98', inputs: ['src/**'] } },
    }),
  );
  expect(record('red').out).toContain("contests nothing: dirty declaration 'proof.yaml'");
  record('red');
  expect(proof()).toEqual([{ result_id: 1 }]);
  expect(contradictions()).toEqual([]);
  repo.git('restore', '.');
  plan('PROVEN lint');
});

test('a failed contradiction insert rolls back its red result', () => {
  const { repo, env, db, proof, contradictions, plan } = setup();
  db.exec(`CREATE TRIGGER reject_contradiction BEFORE INSERT ON contradictions
    BEGIN SELECT RAISE(ABORT, 'injected contradiction failure'); END`);
  const result = repo.cli(['record', 'lint', '--outcome', 'red'], env);
  expect(result.code).toBe(2);
  expect(result.err).toContain('injected contradiction failure');
  expect(db.query('SELECT outcome FROM results').all()).toEqual([{ outcome: 'green' }]);
  expect(proof()).toEqual([{ result_id: 1 }]);
  expect(contradictions()).toEqual([]);
  plan('PROVEN lint');
});

test('ignored selected files block proof reuse and publication without contesting clean proof', () => {
  const { repo, record, plan, proof, contradictions, db } = setup();
  repo.commit({ '.gitignore': 'src/generated.ts\nnotes/\nproof.d/new.yaml\n' });
  repo.write('notes/todo.md', 'unrelated ignored file');
  plan('PROVEN lint');
  repo.write('src/generated.ts', 'ignored input');
  plan("RUN lint: undecidable: dirty input 'src/generated.ts'");
  expect(record('green').out).toContain('no proof published: dirty path');
  expect(record('red').out).toContain("contests nothing: dirty input 'src/generated.ts'");
  expect(proof()).toEqual([{ result_id: 1 }]);
  expect(contradictions()).toEqual([]);
  expect(db.query('SELECT outcome, dirty FROM results WHERE id > 1').all()).toEqual([
    { outcome: 'green', dirty: 1 },
    { outcome: 'red', dirty: 1 },
  ]);
});

for (const flag of ['assume-unchanged', 'skip-worktree']) {
  for (const path of ['src/a.ts', 'proof.yaml', 'proof.d/tasks.yaml']) {
    test(`${flag} on ${path} blocks proof reuse, publication and contests without changing the index`, () => {
      const { repo, record, plan, proof, contradictions } = setup();
      const root = JSON.parse(repo.git('show', 'HEAD:proof.yaml'));
      repo.commit({
        'proof.yaml': JSON.stringify({ ...root, include: 'proof.d/*.yaml' }),
        'proof.d/tasks.yaml': 'tasks: {}',
      });
      record('green');
      repo.git('update-index', `--${flag}`, path);
      const index = repo.git('ls-files', '-v', '--', path);
      const reason = `dirty ${path === 'src/a.ts' ? 'input' : 'declaration'} '${path}'`;
      plan(`RUN lint: undecidable: ${reason}`);
      repo.write(
        path,
        path === 'src/a.ts' ? 'suppressed edit' : `${repo.git('show', `HEAD:${path}`)}\n`,
      );
      plan(`RUN lint: undecidable: ${reason}`);
      expect(record('green').out).toContain('no proof published: dirty path');
      expect(record('red').out).toContain(`contests nothing: ${reason}`);
      record('red');
      expect(proof()).toEqual([{ result_id: 2 }]);
      expect(contradictions()).toEqual([]);
      expect(repo.git('ls-files', '-v', '--', path)).toBe(index);
      repo.git('update-index', `--no-${flag}`, path);
      repo.git('restore', path);
      plan('PROVEN lint');
    });
  }
}

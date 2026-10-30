import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const states: string[] = [];
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const repo of repos.splice(0)) repo.close();
  for (const path of states.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture(project = 'example') {
  const repo = new Repo();
  repos.push(repo);
  repo.commit({
    'proof.yaml': JSON.stringify({
      version: 1,
      project,
      tasks: { lint: { run: 'exit 99', inputs: ['src/**'] } },
    }),
    'src/a.ts': 'a',
  });
  return repo;
}
function setup(other?: Repo) {
  const repo = fixture();
  const path = mkdtempSync(join(tmpdir(), 'proof-state-'));
  states.push(path);
  const env = { PROOF_STATE_DIR: path };
  function record(outcome: string, target = repo, task = 'lint') {
    const result = target.cli(['record', task, '--outcome', outcome], env);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`recorded ${outcome} ${task}`);
    return result;
  }
  if (other) record('green', other);
  record('green');
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

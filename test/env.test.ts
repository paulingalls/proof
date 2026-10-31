import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const states: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const state of states.splice(0)) rmSync(state, { recursive: true, force: true });
});
function declaration(env?: unknown) {
  return JSON.stringify({
    version: 1,
    project: 'example',
    tasks: { lint: { run: 'exit 99', inputs: ['src/**'], ...(env === undefined ? {} : { env }) } },
  });
}
function fixture(env?: unknown) {
  const repo = Repo.from(`env:${JSON.stringify(env)}`, (r) =>
    r.commit({ 'proof.yaml': declaration(env), 'src/a.ts': 'a' }),
  );
  repos.push(repo);
  const path = mkdtempSync(join(tmpdir(), 'proof-env-'));
  states.push(path);
  return { repo, state: { PROOF_STATE_DIR: path, MODE: undefined } };
}
function success(result: ReturnType<Repo['cli']>) {
  expect(result.code).toBe(0);
  return result.out;
}
const record = ['record', 'lint', '--outcome', 'green'];

test('declared values, absence and empty strings select distinct proofs', () => {
  const { repo, state } = fixture(['MODE']);
  expect(success(repo.cli(record, { ...state, MODE: 'a' }))).toContain('proof published');
  for (const [MODE, expected] of [
    ['a', 'PROVEN lint'],
    ['b', 'RUN lint: no proof for key'],
    [undefined, 'RUN lint: no proof for key'],
  ] as const) {
    expect(success(repo.cli(['plan'], { ...state, MODE }))).toContain(expected);
  }
  expect(success(repo.cli(record, state))).toContain('proof published');
  for (const MODE of ['', 'absent']) {
    expect(success(repo.cli(['plan'], { ...state, MODE }))).toContain('RUN lint: no proof for key');
  }
  expect(success(repo.cli(['plan'], state))).toContain('PROVEN lint');
  expect(success(repo.cli(['plan'], { ...state, UNDECLARED: 'changed' }))).toContain('PROVEN lint');
});

test('check compares env declarations as sets with name-bearing entries', () => {
  const { repo, state } = fixture();
  const refs = [repo.git('rev-parse', 'HEAD')];
  for (const env of [
    ['MODE'],
    ['MODE', 'OTHER'],
    ['OTHER', 'MODE'],
    ['MODE', 'OTHER', 'MODE'],
    ['MODE'],
    ['OTHER'],
  ])
    refs.push(repo.commit({ 'proof.yaml': declaration(env) }));
  const cases = [
    { name: 'add', from: refs[0], to: refs[1], expect: ['lint'] },
    { name: 'extend', from: refs[1], to: refs[2], expect: ['lint'] },
    { name: 'reorder', from: refs[2], to: refs[3], expect: [] },
    { name: 'repeat', from: refs[3], to: refs[4], expect: [] },
    { name: 'replace', from: refs[5], to: refs[6], expect: ['lint'] },
  ];
  repo.write('.git/cases.yaml', JSON.stringify(cases));
  const out = success(repo.cli(['check', '.git/cases.yaml'], { ...state, MODE: 'a', OTHER: 'a' }));
  for (const c of cases) expect(out).toContain(`PASS ${c.name}`);
});

test('env requires a list of nonempty string names', () => {
  for (const [env, diagnostic] of [
    ['MODE', 'env must be a list'],
    [null, 'env must be a list'],
    [[1], 'env name: expected a nonempty string'],
    [[''], 'env name: expected a nonempty string'],
  ] as const) {
    const { repo, state } = fixture(env);
    const result = repo.cli(['plan'], state);
    expect(result.code).toBe(2);
    expect(result.err).toContain("task 'lint'");
    expect(result.err).toContain(diagnostic);
  }
});

test('missing and empty env preserve the pinned version-4 key', () => {
  const { repo, state } = fixture();
  expect(success(repo.cli(record, state))).toContain('proof published');
  expect(success(repo.cli(['plan'], state))).toContain('PROVEN lint');
  const db = new Database(join(state.PROOF_STATE_DIR, 'proof.db'));
  try {
    const v4Hash = '8a638ff8a65e59fb52ec72596e701aa262def4383b69816aab9e11003aa985f9';
    expect(db.query('SELECT key FROM results').all()).toEqual([{ key: v4Hash }]);
    expect(db.query('SELECT key FROM proofs').all()).toEqual([{ key: v4Hash }]);
  } finally {
    db.close();
  }
  repo.commit({ 'proof.yaml': declaration([]) });
  expect(success(repo.cli(['plan'], state))).toContain('PROVEN lint');
});

test('recorded env values never reach store bytes or CLI output', () => {
  const { repo, state } = fixture(['MODE']);
  const env = { ...state, MODE: 'secret-value' };
  const recorded = repo.cli(record, env);
  expect(success(recorded)).toContain('proof published');
  const db = new Database(join(state.PROOF_STATE_DIR, 'proof.db'));
  try {
    expect(db.query('SELECT outcome FROM results').all()).toEqual([{ outcome: 'green' }]);
    expect(db.query('SELECT result_id FROM proofs').all()).toEqual([{ result_id: 1 }]);
  } finally {
    db.close();
  }
  const ref = repo.git('rev-parse', 'HEAD');
  repo.write('.git/cases.yaml', JSON.stringify([{ name: 'same', from: ref, to: ref, expect: [] }]));
  const plain = repo.cli(['plan'], env);
  const json = repo.cli(['plan', '--json'], env);
  const checked = repo.cli(['check', '.git/cases.yaml'], env);
  expect(success(plain)).toContain('PROVEN lint');
  expect(JSON.parse(success(json))[0].state).toBe('PROVEN');
  expect(success(checked)).toContain('PASS same');
  for (const file of readdirSync(state.PROOF_STATE_DIR, { recursive: true })) {
    expect(readFileSync(join(state.PROOF_STATE_DIR, String(file))).includes('secret-value')).toBe(
      false,
    );
  }
  for (const { out, err } of [recorded, plain, json, checked])
    expect(out + err).not.toContain('secret-value');
});

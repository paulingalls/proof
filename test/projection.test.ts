import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const states: string[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.close();
  for (const path of states.splice(0)) rmSync(path, { recursive: true, force: true });
});
const projection = { path: 'package.json', json: ['dependencies'] };
const task = (inputs: unknown[]) => ({ run: 'true', inputs });
const manifest = (version = 1, dependencies = { a: 1, b: 2 }) =>
  JSON.stringify({ version, dependencies, config: [{ b: 1, a: 1 }] });
function fixture(
  tasks: Record<string, ReturnType<typeof task>> = {
    deps: task(['src/**', projection]),
    whole: task(['package.json', projection]),
  },
  inputs = {},
) {
  const yaml = JSON.stringify({ version: 1, project: 'fixture', inputs, tasks });
  const r = Repo.from(`projection:${yaml}`, (r) =>
    r.commit({
      'proof.yaml': yaml,
      'package.json': manifest(),
      'src/a.ts': 'a',
      other: 'a',
      'a#b': '{"c":1}',
      a: '{"b#c":1}',
    }),
  );
  repos.push(r);
  return r;
}
function check(r: Repo, cases: [string, string, string, string[]][]) {
  const result = r.check(cases.map(([name, from, to, expect]) => ({ name, from, to, expect })));
  expect(result.err).toBe('');
  expect(result.code, result.out).toBe(0);
  for (const [name] of cases) expect(result.out).toContain(`PASS ${name}`);
  return result.out;
}

test('projects members alongside ordinary inputs without hashing unrelated members', () => {
  const r = fixture();
  const a = r.git('rev-parse', 'HEAD');
  const b = r.commit({ 'package.json': manifest(2) });
  const c = r.commit({ 'package.json': manifest(2, { a: 1, b: 3 }) });
  const d = r.commit({ 'src/a.ts': 'changed' });
  check(r, [
    ['version', a, b, ['whole']],
    ['dependency', b, c, ['deps', 'whole']],
    ['source', c, d, ['deps']],
  ]);
});

test('canonical member identity preserves absence and separate path/member fields', () => {
  const r = fixture({
    deps: task([{ ...projection, json: ['dependencies', 'config', 'engines'] }]),
    alias: task([{ path: 'a#b', json: ['c'] }]),
  });
  const a = r.git('rev-parse', 'HEAD');
  const b = r.commit({ 'package.json': manifest(2, { b: 2, a: 1 }) });
  const c = r.commit({
    'package.json': '{"version":2,"dependencies":{"a":1,"b":2},"config":[{"a":1,"b":1}]}',
  });
  const doc = JSON.parse(r.git('show', 'HEAD:proof.yaml'));
  doc.tasks.deps.inputs[0].json = ['engines', 'config', 'dependencies', 'dependencies'];
  const d = r.commit({ 'proof.yaml': JSON.stringify(doc) });
  const e = r.commit({
    'package.json': JSON.stringify({
      ...JSON.parse(r.git('show', 'HEAD:package.json')),
      engines: null,
    }),
  });
  doc.tasks.alias.inputs = [{ path: 'a', json: ['b#c'] }];
  const f = r.commit({ 'proof.yaml': JSON.stringify(doc) });
  check(r, [
    ['member order', a, b, []],
    ['nested order', b, c, []],
    ['declaration order', c, d, []],
    ['absent to null', d, e, ['deps']],
    ['typed identity', e, f, ['alias']],
  ]);
});

test('expands projections from direct and nested named sets', () => {
  const r = fixture(
    { direct: task(['$deps']), nested: task(['$nested']), other: task(['other']) },
    { deps: [projection], nested: ['$deps'] },
  );
  const a = r.git('rev-parse', 'HEAD');
  const b = r.commit({ 'package.json': manifest(1, { a: 2, b: 2 }) });
  check(r, [['named sets', a, b, ['direct', 'nested']]]);
});

function state(r: Repo, ids: string[]) {
  const path = mkdtempSync(join(tmpdir(), 'proof-projection-'));
  states.push(path);
  const env = { PROOF_STATE_DIR: path };
  for (const id of ids) expect(r.cli(['record', id, '--outcome', 'green'], env).code).toBe(0);
  return env;
}
function plan(r: Repo, env: Record<string, string>) {
  const result = r.cli(['plan', '--json'], env);
  expect(result.code, result.err).toBe(0);
  return JSON.parse(result.out) as { task: string; state: string; reason: string }[];
}

test('unreadable projections run with reasons while other tasks are judged normally', () => {
  for (const content of [undefined, '{', '[]']) {
    const r = fixture({
      deps: task([{ ...projection, path: 'projected.json' }]),
      other: task(['other']),
      changed: task(['src/**']),
    });
    const a = r.commit({ 'projected.json': manifest() });
    const env = state(r, ['other']);
    if (content === undefined) r.git('rm', 'projected.json');
    const b = r.commit({
      'src/a.ts': 'changed',
      ...(content === undefined ? {} : { 'projected.json': content }),
    });
    expect(check(r, [['bad projection', a, b, ['deps', 'changed']]])).toMatch(
      /RUN deps:.*projected\.json/,
    );
    const rows = plan(r, env);
    expect(rows[0]).toEqual({
      task: 'deps',
      state: 'RUN',
      reason: expect.stringMatching(/undecidable:.*projected\.json/),
    });
    expect(rows[1]?.state).toBe('PROVEN');
    expect(rows[2]?.state).toBe('RUN');
  }
});

test('dirty projected paths are undecidable even when only an unselected member changes', () => {
  const r = fixture({ deps: task([projection]), other: task(['other']) });
  const env = state(r, ['deps', 'other']);
  expect(plan(r, env).map((row) => row.state)).toEqual(['PROVEN', 'PROVEN']);
  r.write('package.json', manifest(2));
  const rows = plan(r, env);
  expect(rows[0]).toEqual({
    task: 'deps',
    state: 'RUN',
    reason: "undecidable: dirty input 'package.json'",
  });
  expect(rows[1]?.state).toBe('PROVEN');
});

test('unknown projection fields fail with the task and field name', () => {
  const r = fixture({ deps: task([{ ...projection, surprise: true }]) });
  const result = r.cli(['plan', '--json']);
  expect(result.code).toBe(2);
  for (const word of ['deps', 'surprise']) expect(result.err).toContain(word);
});

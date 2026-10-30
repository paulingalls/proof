import { afterEach, expect, test } from 'bun:test';
import { Repo } from './support/repo';

const repos: Repo[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.close();
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

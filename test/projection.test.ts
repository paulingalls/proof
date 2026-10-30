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
  tasks = { deps: task(['src/**', projection]), whole: task(['package.json', projection]) },
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
  expect(result.code).toBe(0);
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

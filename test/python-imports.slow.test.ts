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
const task = (entry: string, roots?: unknown) => ({
  run: 'true',
  inputs: [{ 'imports-of': entry, ...(roots === undefined ? {} : { 'python-path': roots }) }],
});
function fixture(tasks: Record<string, unknown>, files: Record<string, string>) {
  const r = new Repo();
  repos.push(r);
  r.commit({ 'proof.yaml': JSON.stringify({ version: 1, project: 'python', tasks }), ...files });
  return r;
}
function plan(r: Repo) {
  const path = mkdtempSync(join(tmpdir(), 'proof-python-'));
  states.push(path);
  const result = r.cli(['plan', '--json'], { PROOF_STATE_DIR: path });
  expect(result.code, result.err).toBe(0);
  return JSON.parse(result.out) as { task: string; key?: string; reason: string }[];
}
function changes(r: Repo, files: Record<string, string[]>) {
  const cases = [];
  for (const [path, tasks] of Object.entries(files)) {
    const from = r.git('rev-parse', 'HEAD');
    const to = r.commit({ [path]: `${r.git('show', `HEAD:${path}`)}\n# changed\n` });
    cases.push({ name: path, from, to, expect: tasks });
  }
  const result = r.check(cases);
  expect(result.code, result.err + result.out).toBe(0);
}

test('Python default roots and ordered explicit roots follow transitive imports', () => {
  const r = fixture(
    {
      a: task('tests/t.py'),
      b: task('tests/t.py', ['src', 'lib']),
      c: task('tests/t.py', ['lib', 'src']),
    },
    {
      'tests/t.py': 'import leaf as alias, json',
      'tests/leaf.py': 'import tail',
      'tests/tail.py': '',
      'src/leaf.py': 'import tail',
      'src/tail.py': '',
      'lib/leaf.py': '',
      'other.py': '',
    },
  );
  for (const row of plan(r)) expect(row.key, row.reason).toMatch(/^[a-f0-9]{64}$/);
  changes(r, {
    'tests/leaf.py': ['a'],
    'tests/tail.py': ['a'],
    'src/leaf.py': ['b'],
    'src/tail.py': ['b'],
    'lib/leaf.py': ['c'],
    'other.py': [],
  });
});

test('python-path rejects non-Python entries and malformed directory lists', () => {
  for (const roots of [[], '', ['/tmp'], ['..'], ['a/../b'], ['.git'], [''], [3]]) {
    const r = fixture({ a: task('t.py', roots) }, { 't.py': '' });
    const result = r.cli(['plan']);
    expect(result.code).toBe(2);
    expect(result.err).toContain("task 'a'");
    expect(result.err).toContain(
      'python-path must be a nonempty list of repo-relative directories',
    );
  }
  const r = fixture({ a: task('t.ts', ['.']) }, { 't.ts': '' });
  expect(r.cli(['plan']).err).toContain('python-path needs a .py entry');
});

test('packages, relative members, cycles and Python package precedence', () => {
  const r = fixture(
    { a: task('tests/t.py', ['src', 'lib']) },
    {
      'tests/t.py': 'from p import n as alias\nimport m\nimport ns.x',
      'src/p/__init__.py': 'from . import initdep',
      'src/p/initdep.py': '',
      'src/p/n.py': 'from .sub import n\nfrom . import sibling',
      'src/p/sibling.py': '',
      'src/p/sub/__init__.py': '',
      'src/p/sub/n.py': 'from .. import sibling\nfrom p import n',
      'src/m.py': '',
      'src/m/__init__.py': 'import chosen',
      'src/chosen.py': '',
      'src/ns/x.py': '',
      'lib/ns/__init__.py': '',
      'lib/ns/x.py': '',
      'lib/p/n.py': '',
      'p/__init__.py': '',
    },
  );
  for (const row of plan(r)) expect(row.key, row.reason).toBeDefined();
  changes(
    r,
    Object.fromEntries(
      [
        'src/p/__init__.py',
        'src/p/initdep.py',
        'src/p/n.py',
        'src/p/sibling.py',
        'src/p/sub/__init__.py',
        'src/p/sub/n.py',
        'src/m/__init__.py',
        'src/chosen.py',
        'lib/ns/__init__.py',
        'lib/ns/x.py',
      ]
        .map((path) => [path, ['a']])
        .concat([
          ['src/m.py', []],
          ['src/ns/x.py', []],
          ['lib/p/n.py', []],
          ['p/__init__.py', []],
        ]),
    ),
  );
});

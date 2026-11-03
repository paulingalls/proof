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

test('unresolved local and relative imports name the missing edge; external imports are ignored', () => {
  for (const tracked of ['src/app/__init__.py', 'lib/app.py', 'lib/app/n.py']) {
    const r = fixture({ a: task('tests/t.py') }, { 'tests/t.py': 'import app', [tracked]: '' });
    const row = plan(r)[0];
    expect(row?.key).toBeUndefined();
    expect(row?.reason).toContain('tests/t.py');
    expect(row?.reason).toContain("import 'app'");
    expect(row?.reason).toContain(tracked.replace(/\/__init__.py$|\/n.py$/, ''));
  }
  for (const code of [
    'from . import missing',
    'from .missing import value',
    'from ... import missing',
  ]) {
    const r = fixture({ a: task('tests/t.py') }, { 'tests/t.py': code });
    expect(plan(r)[0]?.reason).toContain('tests/t.py: import');
    expect(plan(r)[0]?.key).toBeUndefined();
  }
  const r = fixture(
    { a: task('t.py') },
    { 't.py': 'import json\nimport local', 'local.py': '', 'other.py': '' },
  );
  expect(plan(r)[0]?.key).toBeDefined();
  changes(r, { 'local.py': ['a'], 'other.py': [] });
});

test('literal dynamic calls follow modules and computed calls are undecidable', () => {
  const calls = ['importlib.import_module', 'import_module', '__import__'];
  const files: Record<string, string> = { 'm.py': '' };
  const tasks: Record<string, unknown> = {};
  for (const [i, call] of calls.entries()) {
    tasks[`a${i}`] = task(`t${i}.py`);
    files[`t${i}.py`] = `${call}(\n "m"\n)`;
  }
  const r = fixture(tasks, files);
  for (const row of plan(r)) expect(row.key, row.reason).toBeDefined();
  changes(r, { 'm.py': ['a0', 'a1', 'a2'] });
  for (const call of calls) {
    for (const arg of ['name', "'m' + suffix", "f'{name}'", "'.m'"]) {
      r.commit({ 't0.py': `${call}(${arg})` });
      const row = plan(r).find((row) => row.task === 'a0');
      expect(row?.key, `${call}(${arg})`).toBeUndefined();
      expect(row?.reason).toContain('t0.py');
      expect(row?.reason).toContain(call);
    }
  }
});

test('lexical boundaries preserve real imports and suppress import-looking prose', () => {
  const r = fixture(
    { a: task('t.py') },
    {
      't.py': String.raw`
"""import decoy
import_module(name)
"""
single = 'import decoy'
double = "__import__('decoy')"
escaped = 'it\'s import decoy'
raw = r'''from decoy import x'''
# import decoy; import_module(name)
def test_it():
    import a as alias, b
    if True: from p import (
        n as value,
    )
    import c, \
        d as other
    __import__('\x65')
`,
      'a.py': '',
      'b.py': '',
      'c.py': '',
      'd.py': '',
      'e.py': '',
      'p/__init__.py': '',
      'p/n.py': 'import tail',
      'tail.py': '',
      'decoy.py': '',
    },
  );
  expect(plan(r)[0]?.key).toBeDefined();
  changes(
    r,
    Object.fromEntries(
      ['a.py', 'b.py', 'c.py', 'd.py', 'e.py', 'p/__init__.py', 'p/n.py', 'tail.py']
        .map((p) => [p, ['a']])
        .concat([['decoy.py', []]]),
    ),
  );
});

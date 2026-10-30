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
const input = (entry: string) => ({ 'imports-of': entry });
const task = (entry: string, run = 'true') => ({ run, inputs: [input(entry)] as unknown[] });
function fixture(
  tasks: Record<string, ReturnType<typeof task>> = { a: task('src/a.ts'), b: task('src/b.ts') },
  files = {},
  extra = {},
) {
  const doc = { version: 1, project: 'imports', tasks, ...extra };
  const r = Repo.from(JSON.stringify([doc, files]), (r) =>
    r.commit({
      'proof.yaml': JSON.stringify(doc),
      'src/a.ts': "import './lib/x';",
      'src/b.ts': "import './lib/y';",
      'src/lib/x.ts': 'export const x = 1;',
      'src/lib/y.ts': 'export const y = 1;',
      other: 'a',
      ...files,
    }),
  );
  repos.push(r);
  return r;
}
function check(r: Repo, cases: [string, string, string, string[]][]) {
  const result = r.check(cases.map(([name, from, to, expect]) => ({ name, from, to, expect })));
  expect(result.code, result.err + result.out).toBe(0);
}
function state() {
  const path = mkdtempSync(join(tmpdir(), 'proof-imports-'));
  states.push(path);
  return { PROOF_STATE_DIR: path };
}
function plan(r: Repo, env = state()) {
  const result = r.cli(['plan', '--json'], env);
  expect(result.code, result.err).toBe(0);
  return JSON.parse(result.out) as { task: string; state: string; reason: string }[];
}

test('ref closures select exactly the affected branch', () => {
  const r = fixture();
  const a = r.git('rev-parse', 'HEAD');
  const b = r.commit({ 'src/lib/x.ts': 'export const x = 2;' });
  const c = r.commit({ 'src/lib/y.ts': 'export const y = 2;' });
  const d = r.commit({ other: 'b' });
  r.write('src/a.ts', "import './missing';");
  check(r, [
    ['x', a, b, ['a']],
    ['y', b, c, ['b']],
    ['other', c, d, []],
    ['same', d, d, []],
  ]);
});

test('follows reexports, cycles, resolution order, leaves and ordered exclusions', () => {
  const r = fixture(
    { a: task('src/a.ts'), b: task('src/b.ts') },
    {
      'src/lib/x.ts': "export * from './deep';",
      'src/lib/deep.ts': "export * from './x'; export const n = 1;",
      'src/a.ts':
        "import './lib/x'; import './util.js'; import './dir'; require('./data.json'); import('./lazy'); import './asset'; import './pick';",
      'src/util.ts': 'export const n = 1;',
      'src/dir/index.ts': 'export {};',
      'src/data.json': '{}',
      'src/lazy.mts': "import './nested.cts';",
      'src/nested.cts': 'export {};',
      'src/asset': 'arbitrary bytes',
      'src/asset.ts': 'export {};',
      'src/pick.ts': 'export {};',
      'src/pick.tsx': 'export {};',
    },
  );
  let from = r.git('rev-parse', 'HEAD');
  const cases: [string, string, string, string[]][] = [];
  for (const path of [
    'lib/deep.ts',
    'util.ts',
    'dir/index.ts',
    'data.json',
    'nested.cts',
    'asset',
    'pick.tsx',
    'asset.ts',
    'pick.ts',
  ]) {
    const to = r.commit({
      [`src/${path}`]: path.endsWith('json')
        ? '{"n":1}'
        : path === 'asset'
          ? 'changed'
          : 'export const changed = 1;',
    });
    cases.push([path, from, to, ['asset.ts', 'pick.ts'].includes(path) ? [] : ['a']]);
    from = to;
  }
  check(r, cases);
  const doc = JSON.parse(r.git('show', 'HEAD:proof.yaml'));
  doc.tasks.a.inputs.push('!src/lib/x.ts');
  from = r.commit({ 'proof.yaml': JSON.stringify(doc) });
  const to = r.commit({ 'src/lib/x.ts': "export * from './deep'; export const changed = 2;" });
  check(r, [['excluded', from, to, []]]);
});

test('type-only edges enter the key independently of computed-call guards', () => {
  const r = fixture(
    { a: task('src/a.ts') },
    {
      'src/a.ts': "import type { T } from /* comment */ './types';",
      'src/types.ts': "export type { T } from './more';",
      'src/more.ts': "import { type X } from './last'; export type T = X;",
      'src/last.ts': 'export type X = number;',
    },
  );
  const a = r.git('rev-parse', 'HEAD');
  const b = r.commit({ 'src/last.ts': 'export type X = string;' });
  const c = r.commit({ other: 'b' });
  check(r, [
    ['types', a, b, ['a']],
    ['other', b, c, []],
  ]);
});

test('computed calls and unresolved imports are undecidable with file and expression', () => {
  for (const [code, word] of [
    ['import(name)', 'name'],
    ["require('./lib/' + name)", "'./lib/' + name"],
    ['import(`./${name}`)', '${name}'],
    ['const x = <div/>; require(name)', 'name'],
    ['require /* comment */ (name)', 'name'],
    ["import './missing'", './missing'],
    ["import './bad'", 'bad.ts'],
  ]) {
    const r = fixture(
      { a: task('src/a.tsx') },
      { 'src/a.tsx': code, 'src/bad.ts': 'export const = ;' },
    );
    const row = plan(r)[0];
    expect(row?.reason).toContain('undecidable');
    expect(row?.reason).toContain(word!);
    expect(row?.reason).toContain(word === 'bad.ts' ? 'src/bad.ts' : 'src/a.tsx');
  }
});

test('workspace, aliases, self references and baseUrl imports cannot publish an external proof', () => {
  const cases = [
    ['workspace', "import '@local/pkg/sub';", 'workspace import not followed', '@local/pkg/sub'],
    ['alias', "import 'alias/value';", 'workspace import not followed', 'alias/value'],
    ['self', "import 'root/sub';", 'local import not followed', 'root/sub'],
    ['subpath', "import '#local';", 'local import not followed', '#local'],
    ['base', "import 'lib/x';", 'local import not followed', 'lib/x'],
  ];
  const tasks = Object.fromEntries(cases.map(([name]) => [name!, task(`src/${name}.ts`)]));
  tasks.external = task('external.ts');
  const r = fixture(tasks, {
    ...Object.fromEntries(cases.map(([name, code]) => [`src/${name}.ts`, code!])),
    'external.ts': "import 'example'; import 'bun:sqlite';",
    'package.json': '{"name":"root","workspaces":["packages/*"]}',
    'packages/p/package.json': '{"name":"@local/pkg"}',
    'config.json': '{"compilerOptions":{"paths":{"alias/*":["src/*"]}}}',
    'src/tsconfig.json':
      '{/*comment*/"extends":"../config.json","compilerOptions":{"baseUrl":"."}}',
  });
  const env = state();
  expect(r.cli(['record', 'external', '--outcome', 'green'], env).code).toBe(0);
  const rows = plan(r, env);
  for (const [name, , reason, edge] of cases) {
    const row = rows.find((row) => row.task === name);
    for (const word of ['undecidable', reason!, edge!, `src/${name}.ts`])
      expect(row?.reason).toContain(word);
  }
  expect(rows.at(-1)?.state).toBe('PROVEN');
});

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const states: string[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.close();
  for (const p of states.splice(0)) rmSync(p, { recursive: true, force: true });
});
function fixture(files: Record<string, string> = {}) {
  const r = Repo.from(JSON.stringify(['workspaces', files]), (r) =>
    r.commit({
      'proof.yaml': JSON.stringify({
        version: 1,
        project: 'workspaces',
        tasks: {
          a: { run: 'true', inputs: [{ 'imports-of': 'packages/db/src/q.test.ts' }] },
          b: { run: 'true', inputs: [{ 'imports-of': 'other.ts' }] },
        },
      }),
      'package.json': '{"workspaces":["packages/*"]}',
      'packages/db/src/q.test.ts': "import './q';",
      'packages/db/src/q.ts': "import '@app/shared';",
      'packages/shared/package.json': '{"name":"@app/shared","exports":"./src/index.ts"}',
      'packages/shared/src/index.ts': 'export const n = 1;',
      'other.ts': 'export {};',
      unrelated: 'a',
      ...files,
    }),
  );
  repos.push(r);
  return r;
}
function state() {
  const p = mkdtempSync(join(tmpdir(), 'proof-workspaces-'));
  states.push(p);
  return { PROOF_STATE_DIR: p };
}
function plan(r: Repo, env = state()) {
  const result = r.cli(['plan', '--json'], env);
  expect(result.code, result.err).toBe(0);
  return JSON.parse(result.out) as { task: string; state: string; reason: string }[];
}
function changes(r: Repo, edits: [string, string, string[]][]) {
  let from = r.git('rev-parse', 'HEAD');
  const cases = [{ name: 'same', from, to: from, expect: [] as string[] }];
  for (const [path, text, expected] of [
    ...edits,
    ['unrelated', 'b', []] as [string, string, string[]],
  ]) {
    const to = r.commit({ [path]: text });
    cases.push({ name: path, from, to, expect: expected });
    from = to;
  }
  const result = r.check(cases);
  expect(result.code, result.out + result.err).toBe(0);
  expect(result.out).not.toContain('  RUN ');
}

test('AC1 workspace source enters the closure and clean proofs reuse', () => {
  for (const workspaces of [['packages/*'], { packages: ['./packages/*/'] }]) {
    const r = fixture({ 'package.json': JSON.stringify({ workspaces }) });
    const env = state();
    expect(r.cli(['record', 'a', '--outcome', 'green'], env).code).toBe(0);
    expect(plan(r, env)[0]?.state).toBe('PROVEN');
    changes(r, [['packages/shared/src/index.ts', 'export const n = 2;', ['a']]]);
  }
});
test('AC2 explicit subpaths and nearest tsconfig aliases follow their targets', () => {
  const r = fixture({
    'packages/db/src/q.ts': "import '@app/shared/sub'; import '@/lib/x';",
    'packages/shared/package.json': '{"name":"@app/shared","exports":{"./sub":"./src/index.ts"}}',
    'packages/db/tsconfig.json':
      '{"extends":"../../config.json","compilerOptions":{"baseUrl":"."}}',
    'config.json': '{/* JSONC */"compilerOptions":{"paths":{"@/lib/*":["missing/*","src/*"]}}}',
    'packages/db/src/x.ts': 'export {};',
  });
  changes(r, [
    ['packages/shared/src/index.ts', 'export const n = 2;', ['a']],
    ['packages/db/src/x.ts', 'export const x = 2;', ['a']],
  ]);
});
test('AC3 selected manifest bytes re-key even when the target stays the same', () => {
  const r = fixture();
  const env = state();
  expect(r.cli(['record', 'a', '--outcome', 'green'], env).code).toBe(0);
  changes(r, [
    [
      'packages/shared/package.json',
      '{"name":"@app/shared","exports":{".":"./src/index.ts","./unused":"./unused.ts"}}',
      ['a'],
    ],
  ]);
  expect(plan(r, env)[0]?.reason).not.toContain('undecidable');
  expect(plan(r, env)[0]?.state).toBe('RUN');
  expect(r.cli(['record', 'a', '--outcome', 'green'], env).code).toBe(0);
  expect(plan(r, env)[0]?.state).toBe('PROVEN');
});
test('AC4 unsupported exports name the package and cannot publish proof', () => {
  for (const target of [
    { browser: './src/index.ts', types: './src/index.ts' },
    null,
    ['./src/index.ts'],
    './missing.ts',
    '../escape.ts',
    { './other': './src/index.ts' },
  ]) {
    const r = fixture({
      'packages/shared/package.json': JSON.stringify({
        name: '@app/shared',
        main: './src/index.ts',
        exports: target,
      }),
    });
    const env = state();
    const reason = plan(r, env)[0]?.reason;
    for (const word of ['undecidable', 'exports', '@app/shared', 'packages/db/src/q.ts'])
      expect(reason).toContain(word);
    r.cli(['record', 'a', '--outcome', 'green'], env);
    expect(plan(r, env)[0]?.state).toBe('RUN');
  }
}, 15000);
test('AC5 conditional exports preserve object order and edge kind', () => {
  const r = fixture({
    'packages/shared/package.json':
      '{"name":"@app/shared","exports":{".":{"default":"./d.ts","bun":"./b.ts"},"./edge":{"node":{"import":"./i.ts","require":"./r.ts"}}}}',
    'packages/db/src/q.ts':
      "import '@app/shared'; import('@app/shared/edge'); require('@app/shared/edge'); import type {T} from '@app/shared/edge';",
    'packages/shared/d.ts': 'export {};',
    'packages/shared/b.ts': 'export {};',
    'packages/shared/i.ts': 'export type T = number;',
    'packages/shared/r.ts': 'export {};',
  });
  changes(r, [
    ['packages/shared/d.ts', 'export const d = 1;', ['a']],
    ['packages/shared/b.ts', 'export const b = 1;', []],
    ['packages/shared/i.ts', 'export type T = string;', ['a']],
    ['packages/shared/r.ts', 'export const r = 1;', ['a']],
  ]);
});
test('AC6 adding an alias to a previously external import invalidates proof', () => {
  for (const initial of [{} as Record<string, string>, { 'tsconfig.json': '{}' }]) {
    const r = fixture({ ...initial, 'packages/db/src/q.ts': "import 'alias';" });
    const env = state();
    expect(r.cli(['record', 'a', '--outcome', 'green'], env).code).toBe(0);
    expect(plan(r, env)[0]?.state).toBe('PROVEN');
    changes(r, [
      [
        'tsconfig.json',
        '{"compilerOptions":{"paths":{"alias":["./packages/shared/src/index.ts"]}}}',
        ['a'],
      ],
    ]);
    expect(plan(r, env)[0]?.reason).not.toContain('undecidable');
    expect(plan(r, env)[0]?.state).toBe('RUN');
    expect(r.cli(['record', 'a', '--outcome', 'green'], env).code).toBe(0);
    expect(plan(r, env)[0]?.state).toBe('PROVEN');
  }
});

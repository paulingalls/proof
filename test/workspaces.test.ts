import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
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
    'packages/db/src/q.ts': "import '@app/shared'; import('@app/shared/edge');",
    'other.ts': "require('@app/shared/edge');",
    'types.ts': "import type {T} from '@app/shared/edge';",
    'packages/shared/d.ts': 'export {};',
    'packages/shared/b.ts': 'export {};',
    'packages/shared/i.ts': 'export type T = number;',
    'packages/shared/r.ts': 'export {};',
  });
  const doc = JSON.parse(r.git('show', 'HEAD:proof.yaml'));
  doc.tasks.c = { run: 'true', inputs: [{ 'imports-of': 'types.ts' }] };
  r.commit({ 'proof.yaml': JSON.stringify(doc) });
  changes(r, [
    ['packages/shared/d.ts', 'export const d = 1;', ['a']],
    ['packages/shared/b.ts', 'export const b = 1;', []],
    ['packages/shared/i.ts', 'export type T = string;', ['a', 'c']],
    ['packages/shared/r.ts', 'export const r = 1;', ['b']],
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
test('new dirty aliases and extension shadows cannot reuse committed proof', () => {
  const r = fixture({
    'packages/db/src/q.ts': "import 'alias'; import './x';",
    'packages/db/src/x.ts': 'export {};',
  });
  const env = state();
  expect(r.cli(['record', 'a', '--outcome', 'green'], env).code).toBe(0);
  expect(plan(r, env)[0]?.state).toBe('PROVEN');
  r.write('packages/db/tsconfig.json', '{"compilerOptions":{"paths":{"alias":["./src/x.ts"]}}}');
  expect(plan(r, env)[0]?.reason).toContain("dirty input 'packages/db/tsconfig.json'");
  rmSync(join(r.path, 'packages/db/tsconfig.json'));
  r.write('packages/db/src/x.tsx', 'export const x = 2;');
  expect(plan(r, env)[0]?.reason).toContain("dirty input 'packages/db/src/x.tsx'");
});

test('directory entries ignore exports and packages prefer main, index, then module', () => {
  const r = fixture({
    'packages/db/src/q.ts':
      "import './dir'; import '@app/shared'; import '@app/mod'; import '@app/index'; import '@app/shared/sub';",
    'packages/db/src/dir/package.json': '{"exports":"./unused.ts","main":"./chosen"}',
    'packages/db/src/dir/chosen.ts': 'export {};',
    'packages/db/src/dir/index.ts': 'export {};',
    'packages/db/src/dir/unused.ts': 'export {};',
    'packages/shared/package.json':
      '{"name":"@app/shared","main":"./main.ts","module":"./module.ts"}',
    'packages/shared/main.ts': 'export {};',
    'packages/shared/module.ts': 'export {};',
    'packages/shared/sub.ts': 'export {};',
    'packages/mod/package.json': '{"name":"@app/mod","module":"./module.ts"}',
    'packages/mod/module.ts': 'export {};',
    'packages/index/package.json': '{"name":"@app/index","module":"./unused.ts"}',
    'packages/index/index.ts': 'export {};',
    'packages/index/unused.ts': 'export {};',
  });
  changes(r, [
    ...[
      'packages/db/src/dir/chosen.ts',
      'packages/shared/main.ts',
      'packages/shared/sub.ts',
      'packages/mod/module.ts',
      'packages/index/index.ts',
    ].map((p): [string, string, string[]] => [p, 'export const n = 2;', ['a']]),
    ...[
      'packages/db/src/dir/index.ts',
      'packages/db/src/dir/unused.ts',
      'packages/shared/module.ts',
      'packages/shared/src/index.ts',
      'packages/index/unused.ts',
    ].map((p): [string, string, string[]] => [p, 'export const n = 2;', []]),
  ]);
});

test('Bun agrees with main precedence and ordered default conditions', () => {
  const r = fixture({
    'packages/shared/package.json': '{"name":"@app/shared","main":"./m.ts","module":"./unused.ts"}',
    'packages/shared/m.ts': "export default 'main';",
    'packages/shared/unused.ts': "export default 'module';",
    'packages/ordered/package.json':
      '{"name":"@app/ordered","exports":{".":{"default":"./d.ts","bun":"./b.ts"}}}',
    'packages/ordered/d.ts': "export default 'default';",
    'packages/ordered/b.ts': "export default 'bun';",
    'packages/db/src/q.ts': "import '@app/shared'; import '@app/ordered';",
  });
  r.write(
    'packages/ordered/probe.ts',
    "import m from '../shared'; import d from '@app/ordered'; console.log(m,d);",
  );
  const result = Bun.spawnSync([process.execPath, 'packages/ordered/probe.ts'], { cwd: r.path });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString().trim()).toBe('main default');
  changes(r, [
    ['packages/shared/m.ts', "export default 'changed';", ['a']],
    ['packages/ordered/d.ts', "export default 'changed';", ['a']],
    ['packages/ordered/b.ts', "export default 'changed';", []],
  ]);
});

test('config inheritance, jsconfig, exact aliases, builtins and workspace extends', () => {
  const r = fixture({
    'packages/db/src/q.ts':
      "import 'alias/x'; import 'alias/exact'; import 'fs'; import 'bun:sqlite';",
    'packages/db/jsconfig.json':
      '{"extends":"@app/config/base.json","compilerOptions":{"baseUrl":"."}}',
    'packages/config/package.json': '{"name":"@app/config"}',
    'packages/config/base.json':
      '{"compilerOptions":{"paths":{"alias/*":["./src/*"],"alias/exact":["./src/dir"],"fs":["./missing"],"bun:sqlite":["./missing"]}}}',
    'packages/db/src/x.ts': 'export {};',
    'packages/db/src/dir/package.json': '{"main":"./main.ts"}',
    'packages/db/src/dir/main.ts': 'export {};',
    'packages/db/src/dir/index.ts': 'export {};',
    'packages/db/src/exact.ts': 'export {};',
    'tsconfig.json': '{"compilerOptions":{"paths":{"alias/*":["./wrong/*"]}}}',
  });
  changes(r, [
    ['packages/db/src/x.ts', 'export const n = 1;', ['a']],
    ['packages/db/src/dir/main.ts', 'export const n = 1;', ['a']],
    ['packages/db/src/exact.ts', 'export const n = 1;', []],
    ['packages/db/src/dir/index.ts', 'export const n = 1;', []],
    [
      'packages/config/base.json',
      '{"compilerOptions":{"strict":true,"paths":{"alias/*":["./src/*"],"alias/exact":["./src/dir"]}}}',
      ['a'],
    ],
  ]);
});

test('external extends is ignored, child paths replace inherited paths, and discovery excludes unrelated packages', () => {
  const r = fixture({
    'packages/db/src/q.ts': "import '@app/shared'; import 'external';",
    'packages/db/tsconfig.json': '{"extends":"./parent.json","compilerOptions":{"paths":{}}}',
    'packages/db/parent.json':
      '{"extends":"npm-config/tsconfig.json","compilerOptions":{"paths":{"external":["./missing"]}}}',
    'packages/unused/package.json': '{"name":"@app/unused","version":"1"}',
    'excluded/package.json': '{"name":"@app/shared"}',
    'package.json': '{"workspaces":["./packages/*/","excluded","!excluded"]}',
  });
  changes(r, [
    ['packages/unused/package.json', '{"name":"@app/unused","version":"2"}', []],
    [
      'packages/db/parent.json',
      '{"extends":"npm-config/tsconfig.json","compilerOptions":{"strict":true}}',
      ['a'],
    ],
  ]);
});

test('adding and renaming workspace packages matches a previously external import', () => {
  const r = fixture({ 'packages/db/src/q.ts': "import '@app/new';" });
  changes(r, [
    ['packages/new/package.json', '{"name":"@app/not-yet","main":"../shared/src/index.ts"}', []],
    ['packages/new/package.json', '{"name":"@app/new","main":"../shared/src/index.ts"}', ['a']],
  ]);
});

test('dirty alias metadata and new source materialize without publishing a proof', () => {
  const r = fixture({
    'packages/db/src/q.ts': "import {x} from 'alias'; console.log('working target', x);",
    'packages/shared/src/index.ts': 'export const x = 1;',
    'packages/db/tsconfig.json':
      '{"compilerOptions":{"paths":{"alias":["../shared/src/index.ts"]}}}',
  });
  const doc = JSON.parse(r.git('show', 'HEAD:proof.yaml'));
  doc.tasks.a.run = `${process.execPath} packages/db/src/q.ts`;
  r.commit({ 'proof.yaml': JSON.stringify(doc) });
  const env = state();
  expect(r.cli(['record', 'a', '--outcome', 'green'], env).code).toBe(0);
  r.write('packages/db/tsconfig.json', '{"compilerOptions":{"paths":{"alias":["./src/new.ts"]}}}');
  r.write('packages/db/src/new.ts', 'export const x = 42;');
  expect(plan(r, env)[0]?.reason).toContain("dirty input 'packages/db/tsconfig.json'");
  const result = r.cli(['run'], env);
  expect(result.code, result.err + result.out).toBe(0);
  expect(result.out).toContain('working target 42');
  expect(result.out).toContain('green a; no proof published');
});

test('working symlinks fail per task while unrelated proofs remain reusable', () => {
  const r = fixture({
    'packages/db/src/q.ts': "import './x';",
    'packages/db/src/x.ts': 'export {};',
  });
  const env = state();
  for (const id of ['a', 'b'])
    expect(r.cli(['record', id, '--outcome', 'green'], env).code).toBe(0);
  symlinkSync('x.ts', join(r.path, 'packages/db/src/x.tsx'));
  const rows = plan(r, env);
  expect(rows[0]?.reason).toContain('symlink');
  expect(rows[1]?.state).toBe('PROVEN');
});

test('ambiguous entry candidates never publish a guessed closure', () => {
  const r = fixture({
    'packages/shared/package.json': '{"name":"@app/shared"}',
    'packages/shared/index.ts': 'export {};',
    'packages/shared/index.js': 'export {};',
  });
  expect(plan(r)[0]?.reason).toContain('ambiguous directory index');
});

test('a dirty workspace name change cannot masquerade as the previous external proof', () => {
  const r = fixture({
    'packages/db/src/q.ts': "import '@app/new';",
    'packages/new/package.json': '{"name":"@app/old","main":"../shared/src/index.ts"}',
  });
  const env = state();
  expect(r.cli(['record', 'a', '--outcome', 'green'], env).code).toBe(0);
  r.write('packages/new/package.json', '{"name":"@app/new","main":"../shared/src/index.ts"}');
  expect(plan(r, env)[0]?.reason).toContain("dirty input 'packages/new/package.json'");
});

test('a workspace package directory cannot be shadowed by a sibling source file', () => {
  const r = fixture({
    'packages/shared/package.json': '{"name":"@app/shared","main":"./src/index.ts"}',
    'packages/shared.ts': 'export {};',
  });
  changes(r, [
    ['packages/shared/src/index.ts', 'export const n = 2;', ['a']],
    ['packages/shared.ts', 'export const n = 2;', []],
  ]);
});

test('a guessed resolution stays undecidable: alias typo, twin package, two candidates, baseUrl', () => {
  for (const [files, why] of [
    [
      {
        'packages/db/src/q.ts': "import 'alias';",
        'tsconfig.json': '{"compilerOptions":{"paths":{"alias":["./missing.ts"]}}}',
      },
      'unresolved paths alias',
    ],
    [
      {
        'packages/twin/package.json': '{"name":"@app/shared","main":"./i.ts"}',
        'packages/twin/i.ts': 'export {};',
      },
      'duplicate workspace package',
    ],
    [
      {
        'packages/db/src/q.ts': "import '@app/shared/sub';",
        'packages/shared/package.json': '{"name":"@app/shared"}',
        'packages/shared/sub.ts': 'export {};',
        'packages/shared/sub.js': 'export {};',
      },
      'ambiguous import target',
    ],
    [
      {
        'tsconfig.json': '{"compilerOptions":{"baseUrl":"."}}',
        '@app/shared.ts': 'export {};',
      },
      'local import not followed (baseUrl)',
    ],
  ] as [Record<string, string>, string][]) {
    const reason = plan(fixture(files))[0]?.reason;
    expect(reason).toContain('undecidable');
    expect(reason).toContain(why);
  }
});

test('the longest alias prefix wins whatever the declaration order', () => {
  const r = fixture({
    'packages/db/src/q.ts': "import 'a/b/x';",
    'tsconfig.json': '{"compilerOptions":{"paths":{"a/*":["./wrong/*"],"a/b/*":["./right/*"]}}}',
    'right/x.ts': 'export {};',
    'wrong/b/x.ts': 'export {};',
  });
  changes(r, [
    ['right/x.ts', 'export const n = 1;', ['a']],
    ['wrong/b/x.ts', 'export const n = 1;', []],
  ]);
});

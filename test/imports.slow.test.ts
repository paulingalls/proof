import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
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
  return JSON.parse(result.out) as { task: string; state: string; reason: string; key?: string }[];
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
    ['const x = <div/>; require(name)', 'name'],
    ['import(name)', 'name'],
    ["const s = `require(other)`; const t = 'import(other)';\nimport(name)", 'name'],
    ["require('./lib/' + name)", "'./lib/' + name"],
    [`import(\`./\${name}\`)`, `\${name}`],
    [`import(\`\${name}\`)`, `\${name}`],
    ['require /* comment */ (name)', 'name'],
    ["import './missing'", './missing'],
    ["import './bad'", 'bad.ts'],
  ] as const) {
    const r = fixture(
      { a: task('src/a.tsx') },
      {
        'src/a.tsx': code,
        'src/bad.ts': 'export const = ;',
        'src/pkg/package.json': '{"main":"main.ts"}',
        'src/pkg/main.ts': 'export {};',
        'src/pkg/index.ts': 'export {};',
      },
    );
    const row = plan(r)[0];
    expect(row?.reason).toContain('undecidable');
    expect(row?.reason).toContain(word);
    expect(row?.reason).toContain(word === 'bad.ts' ? 'src/bad.ts' : 'src/a.tsx');
  }
});

test('a comment that looks like a computed call stays decidable; real ones do not', () => {
  const quiet = fixture(
    { a: task('src/a.tsx') },
    {
      'src/a.tsx': [
        '// free of any native import (story-019).',
        '/* require (name) */',
        "import './lib/x';",
        'export const A = () => <div>a</div>;',
      ].join('\n'),
    },
  );
  expect(plan(quiet)[0]?.reason).toBe('no proof for key');
  for (const code of ['await import (name);', 'require (name);']) {
    const loud = fixture(
      { a: task('src/a.ts') },
      { 'src/a.ts': `// a comment\nconst name = 'x';\n${code}` },
    );
    expect(plan(loud)[0]?.reason).toContain('computed import');
  }
});

test('self references and baseUrl imports cannot publish an external proof', () => {
  const cases: [string, string, string, string][] = [
    ['absolute', "import '/abs/x';", 'local import not followed', '/abs/x'],
    ['self', "import 'root/sub';", 'local import not followed', 'root/sub'],
    ['subpath', "import '#local';", 'local import not followed', '#local'],
    ['base', "import 'lib/x';", 'local import not followed', 'lib/x'],
  ];
  const tasks = Object.fromEntries(cases.map(([name]) => [name, task(`src/${name}.ts`)]));
  tasks.external = task('external.ts');
  const r = fixture(tasks, {
    ...Object.fromEntries(cases.map(([name, code]) => [`src/${name}.ts`, code])),
    'external.ts': "import 'example'; import 'bun:sqlite';",
    'package.json': '{"name":"root","workspaces":["./packages/*","libs/*/"]}',
    'packages/p/package.json': '{"name":"@local/pkg"}',
    'libs/l/package.json': '{"name":"@local/lib"}',
    'config.json': '{"compilerOptions":{"paths":{"alias/*":["src/*"]}}}',
    'src/tsconfig.json':
      '{/*comment*/"extends":"../config.json","compilerOptions":{"baseUrl":"."}}',
  });
  const env = state();
  expect(r.cli(['record', 'external', '--outcome', 'green'], env).code).toBe(0);
  const rows = plan(r, env);
  for (const [name, , reason, edge] of cases) {
    const row = rows.find((row) => row.task === name);
    for (const word of ['undecidable', reason, edge, `src/${name}.ts`])
      expect(row?.reason).toContain(word);
  }
  expect(rows.at(-1)?.state).toBe('PROVEN');
});

test('file URL imports run undecidable and never publish or reuse proof', () => {
  const r = new Repo();
  repos.push(r);
  const specifier = new URL(`file://${r.path}/hidden.ts`).href;
  r.commit({
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'file-url',
      tasks: { a: task('main.ts', `'${process.execPath}' main.ts`) },
    }),
    'main.ts': `import value from '${specifier}'; if (value !== 1) throw Error('bad value');`,
    'hidden.ts': 'export default 1;',
  });
  const env = state();
  const run = r.cli(['run'], env);
  expect(run.code, run.err).toBe(0);
  expect(run.out).toContain('green a; not recorded:');
  for (const word of ['undecidable', 'main.ts', specifier, 'local import not followed'])
    expect(plan(r, env)[0]?.reason).toContain(word);
  r.commit({ 'hidden.ts': 'export default 2;' });
  expect(plan(r, env)[0]?.state).toBe('RUN');
  const red = r.cli(['run'], env);
  expect(red.code).toBe(1);
  expect(red.out).toContain('bad value');
  expect(red.out).toContain('red a; not recorded:');
});

test('named closures own only index-reachable files and respect exclusions', () => {
  const r = fixture(
    { a: { run: 'true', inputs: ['$closure'] } },
    {},
    {
      inputs: { closure: [input('src/a.ts')] },
      coverage: ['src/lib/x.ts'],
    },
  );
  expect(r.cli(['lint']).code).toBe(0);
  r.write('src/a.ts', 'export {};');
  expect(r.cli(['lint']).code).toBe(0);
  r.git('add', 'src/a.ts');
  expect(r.cli(['lint']).out).toContain("unowned 'src/lib/x.ts'");
  r.write('src/a.ts', "import './lib/x';");
  expect(r.cli(['lint']).code).toBe(1);
  r.git('add', 'src/a.ts');
  expect(r.cli(['lint']).code).toBe(0);
  const doc = JSON.parse(r.git('show', 'HEAD:proof.yaml'));
  doc.tasks.a.inputs.push('!src/lib/x.ts');
  r.write('proof.yaml', JSON.stringify(doc));
  r.git('add', 'proof.yaml');
  expect(r.cli(['lint']).out).toContain("unowned 'src/lib/x.ts'");
  doc.tasks.owner = { run: 'true', inputs: ['src/lib/x.ts'] };
  r.write('proof.yaml', JSON.stringify(doc));
  r.git('add', 'proof.yaml');
  expect(r.cli(['lint']).code).toBe(0);
});

test('missing entries and malformed adapter declarations fail visibly', () => {
  const r = fixture({ a: task('missing.ts') });
  expect(plan(r)[0]?.reason).toContain('missing.ts');
  expect(r.cli(['lint']).out).toContain('missing.ts');
  const doc = JSON.parse(r.git('show', 'HEAD:proof.yaml'));
  doc.tasks.a.inputs = [{ 'imports-of': 'src/a.ts', surprise: true }];
  r.commit({ 'proof.yaml': JSON.stringify(doc) });
  expect(r.cli(['plan']).err).toContain('surprise');
  const undecidable = fixture({ a: task('src/a.ts') }, { 'src/a.ts': 'require(name);' });
  expect(undecidable.cli(['lint']).code).toBe(0);
});

test('dirty leaves and new working edges materialize with the committed key', () => {
  const r = fixture(
    { a: task('src/a.ts', `${process.execPath} src/a.ts`) },
    {
      'src/a.ts': "import {x} from './lib/x'; if (x !== 2) throw Error('wrong bytes');",
    },
  );
  const env = state();
  expect(r.cli(['record', 'a', '--outcome', 'green'], env).code).toBe(0);
  expect(plan(r, env)[0]?.state).toBe('PROVEN');
  for (const staged of [false, true]) {
    r.write('src/lib/x.ts', 'export const x = 2;');
    if (staged) r.git('add', 'src/lib/x.ts');
    expect(plan(r, env)[0]?.reason).toContain("dirty input 'src/lib/x.ts'");
    const run = r.cli(['run'], env);
    expect(run.code, run.err + run.out).toBe(0);
    expect(run.out).toContain('green a; no proof published');
    expect(r.cli(['record', 'a', '--outcome', 'red'], env).out).toContain('contests nothing');
    r.git('reset', '--hard', 'HEAD');
    expect(plan(r, env)[0]?.state).toBe('PROVEN');
  }
  r.write('src/a.ts', "import {x} from './extra'; if(x !== 3) throw Error('missing closure');");
  r.write('src/extra.ts', "export {x} from './more';");
  r.write('.git/info/exclude', '/node_modules/\nsrc/more/index.ts\n');
  r.write('src/more/index.ts', 'export const x = 3;');
  expect(plan(r, env)[0]?.reason).toContain('undecidable');
  const run = r.cli(['run'], env);
  expect(run.code, run.err + run.out).toBe(0);
  expect(run.out).toContain('green a; no proof published');
  const db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
  try {
    const rows = db.query('SELECT key, dirty FROM results ORDER BY id').all() as {
      key: string;
      dirty: number;
    }[];
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((row) => row.key)).size).toBe(1);
    expect(rows.map((row) => row.dirty)).toEqual([0, 1, 1, 1, 1, 1]);
  } finally {
    db.close();
  }
  r.git('reset', '--hard', 'HEAD');
  r.git('clean', '-fd');
  rmSync(join(r.path, 'src/more'), { recursive: true, force: true });
  expect(plan(r, env)[0]?.state).toBe('PROVEN');
});

test('closure tuple identity preserves modes and equivalent explicit selection', () => {
  const r = fixture({ a: task('src/a.ts') });
  const a = r.git('rev-parse', 'HEAD');
  chmodSync(join(r.path, 'src/lib/x.ts'), 0o755);
  r.git('add', 'src/lib/x.ts');
  r.git('commit', '-qm', 'mode');
  const b = r.git('rev-parse', 'HEAD');
  const doc = JSON.parse(r.git('show', 'HEAD:proof.yaml'));
  doc.tasks.a.inputs = ['src/a.ts', 'src/lib/x.ts'];
  const c = r.commit({ 'proof.yaml': JSON.stringify(doc) });
  check(r, [
    ['mode', a, b, ['a']],
    ['equivalent', b, c, []],
  ]);
});

test('metadata changes are judged at the supplied ref and invalid configs stay undecidable', () => {
  const r = fixture({ a: task('src/a.ts') }, { 'src/a.ts': "import 'alias';" });
  const a = r.git('rev-parse', 'HEAD');
  const b = r.commit({
    'tsconfig.json': '{"compilerOptions":{"paths":{"alias":["src/lib/x.ts"]}}}',
  });
  r.git('rm', 'tsconfig.json');
  const c = r.commit({});
  check(r, [
    ['new alias', a, b, ['a']],
    ['removed alias', a, c, []],
  ]);
  for (const config of ['{', '{"extends":"./missing"}', '{"compilerOptions":{"paths":[]}}']) {
    r.commit({ 'tsconfig.json': config });
    const reason = plan(r)[0]?.reason;
    expect(reason).toContain('undecidable');
    expect(reason).toContain('src/a.ts');
    expect(reason).toContain('alias');
  }
});

test('reached symlinks are undecidable before their target bytes can masquerade as a blob', () => {
  const r = fixture({ a: task('src/a.ts') }, { 'src/a.ts': "import './link';" });
  symlinkSync('lib/x.ts', join(r.path, 'src/link.ts'));
  r.commit({});
  expect(plan(r)[0]?.reason).toContain('src/link.ts: unsupported mode 120000');
});

test('an ignored file shadowing a closure file cannot publish a proof of its bytes', () => {
  const r = fixture(
    { a: task('src/a.ts', `${process.execPath} src/a.ts`) },
    { 'src/a.ts': "import {x} from './lib/x'; if (x !== 1) throw Error('wrong bytes');" },
  );
  r.write('.git/info/exclude', '/node_modules/\nsrc/lib/x.tsx\n');
  r.write('src/lib/x.tsx', 'export const x = 2;');
  const run = r.cli(['run'], state());
  expect(run.code, run.err + run.out).toBe(0);
  expect(run.out).toContain('green a; proof published');
});

test('ordered exclusions remove newly reached ignored working targets', () => {
  const a = task('src/a.ts', 'test ! -e src/hidden.ts');
  a.inputs.push('!src/hidden.ts');
  const r = fixture({ a });
  r.write('.git/info/exclude', '/node_modules/\nsrc/hidden.ts\n');
  r.write('src/a.ts', "import './hidden';");
  r.write('src/hidden.ts', 'export {};');
  const run = r.cli(['run'], state());
  expect(run.code, run.err + run.out).toBe(0);
});

test('import-looking strings and templates add no edges', () => {
  const codes = [
    ...["'", '"', '`'].flatMap((quote) =>
      ['import', 'require'].flatMap((call) =>
        ["'./decoy'", 'name'].map(
          (arg) => `const s = ${quote}${call}(${arg.replaceAll(quote, `\\${quote}`)})${quote};`,
        ),
      ),
    ),
    "const s = `line one\nimport('./decoy')\nrequire(name)`;",
    "// import('./decoy')\n/* require('./decoy') */",
    `const s = \`await import(\${JSON.stringify(path)})\`;`,
    String.raw`const s = 'it\'s import("./decoy")';`,
    "const s = `escaped \\` import('./decoy')`;",
    `const s = \`\${await import(name)}\`;`,
    `const s = "from './missing'";`,
    "const s = `import { T } from './missing'`;",
    "const s = `import type { T } from './missing'`;",
    "const s = `import { T } from './decoy'`;",
    "const s = `export type { T } from './decoy'`;",
    "const a = 'taken from'; const r = /\\d/; const b = 'x';",
    `const p = <p title="pick from" className={\`x \${y}\`} id="z" />;`,
  ];
  const r = fixture(
    Object.fromEntries(codes.map((_, i) => [`case${i}`, task(`src/case${i}.tsx`)])),
    {
      ...Object.fromEntries(codes.map((code, i) => [`src/case${i}.tsx`, code])),
      'src/decoy.ts': 'export type T = number;',
    },
  );
  const env = state();
  const before = plan(r, env);
  for (const row of before) {
    expect(row.reason).toBe('no proof for key');
    expect(row.key).toMatch(/^[a-f0-9]{64}$/);
  }
  r.commit({ 'src/decoy.ts': 'export type T = string;' });
  expect(plan(r, env)).toEqual(before);
});

test('type-only forms keep edges without breaking type identifiers or aliases', () => {
  const codes = [
    "export type A = import('./leaf').T;",
    `const s = \`\${import('./leaf')}\`;`,
    `const s = \`\${require('./leaf')}\`;`,
    `const s = \`a \${x ? \`b\` : 'c'} d\`; export type A = import('./leaf').T;`,
    "const c = (s: string) => s.replace(/\\/*$/, '');\nexport type A = import('./leaf').T;",
    "const p = <p>it's text</p>;\nexport type A = import('./leaf').T;",
    "import type { T } from './leaf';",
    "import type T from './leaf';",
    "import type * as T from './leaf';",
    "import { type T } from './leaf';",
    "import {\n  type T,\n  type U,\n} from './leaf';",
    "import /* c */ type /* c */ { T } from './leaf';",
    "export type { T } from './leaf';",
    "export type * from './leaf';",
    "export type * as T from './leaf';",
    "export { type T } from './leaf';",
    "import type from './leaf';",
    "import type, { a } from './leaf';",
    "import { type } from './leaf';",
    "import { type as a } from './leaf';",
    "export { type } from './leaf';",
    "import d from './leaf' with { type: 'json' };",
    "export type A = number\nimport './leaf';",
    "import './leaf'; function f() { type L<T> = T; }",
    'import type { T } from "./leaf"; const s = `import type X from "./missing"`;',
    "import type { Größe } from './leaf';",
    "import type Größe from './leaf';",
    "import { type Größe } from './leaf';",
    `export {\n${'  /** doc */\n  a,\n'.repeat(30)}};\nexport type { T } from './leaf';`,
  ];
  const r = fixture(
    Object.fromEntries(codes.map((_, i) => [`case${i}`, task(`src/case${i}.tsx`)])),
    {
      ...Object.fromEntries(codes.map((code, i) => [`src/case${i}.tsx`, code])),
      'src/leaf.ts': 'export type T = number; export type U = T; export default 1;',
    },
  );
  const env = state();
  const before = plan(r, env);
  for (const row of before)
    expect(row.key, codes[Number(row.task.slice(4))]).toMatch(/^[a-f0-9]{64}$/);
  r.commit({ 'src/leaf.ts': 'export type T = string; export type U = T; export default 2;' });
  for (const [i, row] of plan(r, env).entries()) {
    expect(row.key, codes[i] + row.reason).toMatch(/^[a-f0-9]{64}$/);
    expect(row.key, codes[i]).not.toBe(before[i]?.key);
  }
});

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
const closure = { 'imports-of': 'entry.ts' };
const root = { name: 'root', version: '1', workspaces: ['packages/*'], scripts: { test: 'true' } };
const pkg = { name: 'pkg', version: '1', exports: './a.ts' };
const manifest = 'packages/p/package.json';
const manifests = [
  ['package.json', root],
  [manifest, pkg],
] as const;
function fixture(inputs: Record<string, unknown[]> = { a: [closure] }, run = 'true') {
  const r = new Repo();
  repos.push(r);
  r.commit({
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'manifests',
      tasks: Object.fromEntries(
        Object.entries(inputs).map(([id, inputs]) => [id, { run, inputs, env: ['EXPECTED'] }]),
      ),
    }),
    'package.json': JSON.stringify(root),
    [manifest]: JSON.stringify(pkg),
    'entry.ts': "import 'pkg'; import './packages/p/a'; import './packages/p/b';",
    'packages/p/a.ts': 'export {};',
    'packages/p/b.ts': 'export {};',
    'direct.ts': "import './package.json';",
  });
  const path = mkdtempSync(join(tmpdir(), 'proof-manifests-'));
  states.push(path);
  const cli = (args: string[], EXPECTED?: string) => {
    const result = r.cli(args, { PROOF_STATE_DIR: path, EXPECTED });
    expect(result.code, result.err + result.out).toBe(0);
    return result.out;
  };
  return { r, cli };
}
test('design case 3: committed root and workspace version bumps retain proof', () => {
  const { r, cli } = fixture();
  cli(['record', 'a', '--outcome', 'green']);
  expect(cli(['plan'])).toContain('PROVEN a');
  for (const [path, value] of manifests) {
    r.commit({ [path]: JSON.stringify({ ...value, version: '2' }), CHANGELOG: 'release' });
    expect(cli(['plan'])).toContain('PROVEN a');
    expect(cli(['why', 'a'])).toContain('no inputs changed');
  }
  r.commit({ [manifest]: JSON.stringify({ ...pkg, main: './b.ts' }) });
  expect(cli(['why', 'a'])).toContain(`changed member ${manifest} main`);
});

test('whole-file selection preserves version exclusion in either input and traversal order', () => {
  const direct = { 'imports-of': 'direct.ts' };
  const { r, cli } = fixture({
    a: [closure],
    first: [{ 'imports-of': 'first.ts' }],
    last: [{ 'imports-of': 'last.ts' }],
    pathFirst: ['package.json', closure],
    pathLast: [closure, 'package.json'],
    globFirst: ['**/package.json', closure],
    globLast: [closure, '**/package.json'],
    two: [closure, direct],
    excluded: [closure, '!package.json'],
    readded: [closure, '!package.json', '*.json'],
    flow: [closure, { maestro: 'flow.yaml' }],
  });
  const from = r.commit({
    'first.ts': "import 'pkg'; import './package.json';",
    'last.ts': "import './package.json'; import 'pkg';",
    'flow.yaml': 'appId: x\n---\n- addMedia:\n    - package.json\n',
  });
  expect(cli(['why', 'first'])).toContain('file package.json ');
  const to = r.commit({ 'package.json': JSON.stringify({ ...root, version: '2' }) });
  const readers = 'first last pathFirst pathLast globFirst globLast two readded flow'.split(' ');
  const scripts = r.commit({
    'package.json': JSON.stringify({ ...root, version: '2', scripts: { test: 'false' } }),
  });
  const result = r.check([
    { name: 'version excluded', from, to, expect: [] },
    { name: 'whole reads', from: to, to: scripts, expect: readers },
  ]);
  expect(result.code, result.err + result.out).toBe(0);
});

test('resolution members invalidate even when the source set stays unchanged', () => {
  const { r } = fixture();
  let from = r.git('rev-parse', 'HEAD');
  const cases = [];
  for (const [path, value] of [
    [manifest, { ...pkg, exports: { default: './a.ts', bun: './b.ts' } }],
    [manifest, { ...pkg, exports: { bun: './b.ts', default: './a.ts' } }],
    [manifest, { ...pkg, exports: { '.': './a.ts', './unused': './b.ts' } }],
    [manifest, { ...pkg, main: './b.ts' }],
    [manifest, pkg],
    [manifest, { ...pkg, module: './b.ts' }],
    [manifest, pkg],
    ['package.json', { ...root, name: 'renamed' }],
    ['package.json', { ...root, workspaces: { packages: ['packages/*'] } }],
  ] as const) {
    const to = r.commit({ [path]: JSON.stringify(value) });
    cases.push({ name: `${cases.length}`, from, to, expect: ['a'] });
    from = to;
  }
  const result = r.check(cases);
  expect(result.code, result.err + result.out).toBe(0);
});

test('a manifest a tsconfig extends keys the options the resolver reads from it', () => {
  const { r } = fixture({ a: [{ 'imports-of': 'alias.ts' }] });
  const aliased = (target: string) =>
    JSON.stringify({ ...root, compilerOptions: { paths: { x: [target] } } });
  const from = r.commit({
    'tsconfig.json': '{"extends":"./package.json"}',
    'package.json': aliased('./packages/p/a.ts'),
    'alias.ts': "import 'x'; import './packages/p/a'; import './packages/p/b';",
  });
  const to = r.commit({ 'package.json': aliased('./packages/p/b.ts') });
  const result = r.check([{ name: 'alias', from, to, expect: ['a'] }]);
  expect(result.code, result.err + result.out).toBe(0);
});

test('sandbox keeps exact clean and dirty manifest bytes, with dirty reasons', () => {
  for (const [path, value] of manifests) {
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    const changed = `${JSON.stringify({ ...value, version: '2' }, null, 2)}\n`;
    const { r, cli } = fixture(undefined, `printf '%s' "$EXPECTED" | cmp - ${path}`);
    r.commit({ [path]: bytes });
    expect(cli(['run'], bytes)).toContain('proof published');
    for (const staged of [false, true]) {
      r.write(path, changed);
      if (staged) r.git('add', path);
      const why = cli(['why', 'a'], bytes);
      expect(why).toContain(`RUN a: undecidable: dirty input '${path}'`);
      expect(why).toContain('no inputs changed');
      for (const member of ['name', 'main', 'module', 'type', 'exports', 'imports', 'workspaces'])
        expect(why).toContain(`member ${path} ${member} `);
      expect(why).not.toContain(`file ${path} `);
      expect(cli(['run'], changed)).toContain('green a; no proof published');
      r.git('reset', '--hard', 'HEAD');
      expect(cli(['plan'], bytes)).toContain('PROVEN a');
    }
  }
});

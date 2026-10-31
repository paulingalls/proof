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
function fixture(inputs: Record<string, unknown[]> = { a: [closure] }, run = 'true') {
  const r = new Repo();
  repos.push(r);
  r.commit({
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'manifests',
      tasks: Object.fromEntries(
        Object.entries(inputs).map(([id, inputs]) => [id, { run, inputs }]),
      ),
    }),
    'package.json': JSON.stringify(root),
    [manifest]: JSON.stringify(pkg),
    'entry.ts': "import 'pkg';",
    'packages/p/a.ts': 'export {};',
    'packages/p/b.ts': 'export {};',
    'direct.ts': "import './package.json';",
  });
  const path = mkdtempSync(join(tmpdir(), 'proof-manifests-'));
  states.push(path);
  const cli = (args: string[]) => {
    const result = r.cli(args, { PROOF_STATE_DIR: path });
    expect(result.code, result.err + result.out).toBe(0);
    return result.out;
  };
  return { r, cli };
}

test('design case 3: committed root and workspace version bumps retain proof', () => {
  const { r, cli } = fixture();
  cli(['record', 'a', '--outcome', 'green']);
  expect(cli(['plan'])).toContain('PROVEN a');
  for (const [path, value] of [
    ['package.json', root],
    [manifest, pkg],
  ] as const) {
    r.commit({ [path]: JSON.stringify({ ...value, version: '2' }), CHANGELOG: 'release' });
    expect(cli(['plan'])).toContain('PROVEN a');
  }
});

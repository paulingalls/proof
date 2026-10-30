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
function fixture(tasks = { a: task('src/a.ts'), b: task('src/b.ts') }, files = {}, extra = {}) {
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

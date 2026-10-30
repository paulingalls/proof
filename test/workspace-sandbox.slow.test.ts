import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const states: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const dir of states.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(name: string, scopeLink = false, hidden = false, dependency?: string) {
  const repo = new Repo();
  repos.push(repo);
  const state = mkdtempSync(join(tmpdir(), 'proof-workspace-sandbox-'));
  states.push(state);
  repo.commit({
    '.gitignore': 'scope/\n',
    'package.json': '{"workspaces":["packages/*"]}',
    'packages/shared/package.json': JSON.stringify({ name, exports: './src/index.ts' }),
    'packages/shared/src/index.ts': "export default 'workspace-one';",
    'packages/shared/hidden.txt': 'secret',
    'packages/other/package.json': '{"name":"other"}',
    'packages/other/index.js': 'export default 9;',
    'main.ts': `import value from '${name}'; import external from 'example'; console.log(value, external);${hidden ? `\nimport { readFileSync } from 'node:fs'; console.log(readFileSync('node_modules/${name}/hidden.txt', 'utf8'));` : ''}`,
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'workspace-sandbox',
      tasks: {
        linked: {
          run: `'${process.execPath}' --no-install main.ts`,
          inputs: [{ 'imports-of': 'main.ts' }],
          links: ['node_modules'],
        },
      },
    }),
  });
  if (scopeLink) {
    mkdirSync(join(repo.path, 'scope'));
    symlinkSync('../scope', join(repo.path, 'node_modules/@app'));
  } else if (name.startsWith('@')) mkdirSync(join(repo.path, 'node_modules/@app'));
  symlinkSync(join(repo.path, 'packages/shared'), join(repo.path, 'node_modules', name));
  symlinkSync('../packages/other', join(repo.path, 'node_modules/other'));
  if (dependency) {
    repo.write(
      'node_modules/ext/package.json',
      JSON.stringify({ name: 'ext', [dependency]: { [name]: '*' } }),
    );
    repo.write('node_modules/ext/index.js', `export { default } from '${name}';`);
    repo.commit({ 'main.ts': `import value from 'ext'; console.log(value);` });
  }
  const cli = (...args: string[]) => repo.cli(args, { PROOF_STATE_DIR: state });
  const plan = () => {
    const result = cli('plan', '--json');
    expect(result.code, result.err).toBe(0);
    return JSON.parse(result.out)[0] as { state: string; reason: string };
  };
  return { repo, cli, plan };
}

for (const [name, scopeLink] of [
  ['shared', false],
  ['@app/shared', false],
  ['@app/shared', true],
] as const) {
  test(`workspace ${name}, scope link ${scopeLink}: publish, reuse and invalidate`, () => {
    const { repo, cli, plan } = fixture(name, scopeLink);
    let result = cli('run');
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('workspace-one 1');
    expect(result.out).toContain('green linked; proof published');
    expect(plan().state).toBe('PROVEN');
    expect(plan().reason).not.toContain('escape');
    expect(cli('run').out).toContain('PROVEN linked');
    repo.write('packages/shared/src/index.ts', "export default 'workspace-two';");
    expect(plan().state).toBe('RUN');
    expect(plan().reason).toContain('dirty input');
    result = cli('run');
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('workspace-two 1');
    expect(result.out).toContain('no proof published');
    repo.commit({ 'packages/shared/src/index.ts': "export default 'workspace-two';" });
    expect(plan().state).toBe('RUN');
    expect(cli('run').out).toContain('green linked; proof published');
    expect(plan().state).toBe('PROVEN');
  });

  test(`workspace ${name}, scope link ${scopeLink}: unselected files are absent`, () => {
    const { cli, plan } = fixture(name, scopeLink, true);
    const result = cli('run');
    expect(result.code, result.out + result.err).toBe(1);
    expect(result.err.toLowerCase()).toContain('no such file');
    expect(result.err).toContain('hidden.txt');
    expect(result.out).toContain('red linked');
    expect(result.out).not.toContain('; proof published');
    expect(plan().state).toBe('RUN');
  });
}

for (const dependency of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
  test(`installed package declaring workspace ${dependency} runs unpublished`, () => {
    const { cli, plan } = fixture('@app/shared', false, false, dependency);
    const result = cli('run');
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('workspace-one');
    expect(result.out).toContain('green linked; no proof published:');
    expect(result.out).toContain('ext');
    expect(result.out).toContain('@app/shared');
    expect(plan().state).toBe('RUN');
    expect(plan().reason).toContain('ext');
    expect(plan().reason).toContain('@app/shared');
  });
}

test('workspace discovery errors run unpublished and remain visible in plan', () => {
  const { repo, cli, plan } = fixture('@app/shared');
  repo.commit({ 'packages/other/package.json': '{"name":"@app/shared"}' });
  const decision = plan();
  expect(decision.state).toBe('RUN');
  expect(decision.reason).toContain('workspace discovery');
  expect(decision.reason).toContain('duplicate workspace');
  const result = cli('run');
  expect(result.code, result.err).toBe(0);
  expect(result.out).toContain('workspace-one 1');
  expect(result.out).toContain('workspace discovery');
  expect(result.out).not.toContain('; proof published');
});

test('ordinary dangling and file @ entries do not become scope directories', () => {
  const { repo, cli, plan } = fixture('shared');
  symlinkSync('missing', join(repo.path, 'node_modules/@dangling'));
  repo.write('node_modules/@file', 'installed');
  symlinkSync('@file', join(repo.path, 'node_modules/@file-link'));
  const result = cli('run');
  expect(result.code, result.err).toBe(0);
  expect(result.out).toContain('green linked; proof published');
  expect(plan().state).toBe('PROVEN');
});

test('a physical child inside a symlinked scope remains an unrecognized escape', () => {
  const { repo, cli, plan } = fixture('@app/shared', true);
  repo.write('scope/extra/index.js', 'export default 2;');
  expect(plan().reason).toContain('node_modules/@app/extra');
  const result = cli('run');
  expect(result.code, result.err).toBe(0);
  expect(result.out).toContain('green linked; no proof published:');
  expect(result.out).toContain('node_modules/@app/extra');
  expect(plan().state).toBe('RUN');
});

test('a per-package node_modules (isolated installs) reaches workspace source inside the sandbox', () => {
  const repo = new Repo();
  repos.push(repo);
  const state = mkdtempSync(join(tmpdir(), 'proof-workspace-sandbox-'));
  states.push(state);
  repo.commit({
    '.gitignore': 'node_modules/\n',
    'package.json': '{"workspaces":["packages/*"]}',
    'packages/shared/package.json': '{"name":"@app/shared","exports":"./src/index.ts"}',
    'packages/shared/src/index.ts': "export default 'shared-one';",
    'packages/db/package.json': '{"name":"@app/db"}',
    'packages/db/src/q.ts': "import value from '@app/shared'; console.log(value);",
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'isolated',
      tasks: {
        db: {
          run: `'${process.execPath}' --no-install packages/db/src/q.ts`,
          inputs: [{ 'imports-of': 'packages/db/src/q.ts' }],
          links: ['packages/db/node_modules'],
        },
      },
    }),
  });
  mkdirSync(join(repo.path, 'packages/db/node_modules/@app'), { recursive: true });
  symlinkSync('../../../shared', join(repo.path, 'packages/db/node_modules/@app/shared'));
  const cli = (...args: string[]) => repo.cli(args, { PROOF_STATE_DIR: state });
  let result = cli('run');
  expect(result.code, result.err).toBe(0);
  expect(result.out).toContain('shared-one');
  expect(result.out).toContain('green db; proof published');
  repo.commit({ 'packages/shared/src/index.ts': "export default 'shared-two';" });
  result = cli('run');
  expect(result.out).toContain('shared-two');
  expect(result.out).toContain('green db; proof published');
});

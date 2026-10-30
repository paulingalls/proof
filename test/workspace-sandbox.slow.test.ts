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

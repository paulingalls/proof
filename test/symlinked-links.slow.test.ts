import { afterEach, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

let repo: Repo;
const directories: string[] = [];
afterEach(() => {
  repo?.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'proof-symlink-'));
  directories.push(path);
  return path;
}
function fixture(link: string, run = 'true', files: Record<string, string> = {}) {
  repo = new Repo();
  repo.commit({
    source: 'source',
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'symlinked-links',
      tasks: {
        linked: { run, inputs: ['**'], links: [link] },
        plain: { run: 'true', inputs: ['**'] },
      },
    }),
    ...files,
  });
  const env = { PROOF_STATE_DIR: directory() };
  const cli = (...args: string[]) => repo.cli(args, env);
  const rows = () => {
    const result = cli('plan', '--json');
    expect(result.code, result.err).toBe(0);
    return JSON.parse(result.out) as {
      task: string;
      key?: string;
      reason: string;
      state: string;
    }[];
  };
  return { cli, rows };
}

for (const link of ['node_modules', 'apps/x/node_modules']) {
  test(`declared symlink ${link} preserves task keys and runs with installed contents`, () => {
    const { cli, rows } = fixture(
      link,
      `test -L ${link}/example && test "$(cat ${link}/example/payload)" = installed`,
      { '.gitignore': 'node_modules/\n' },
    );
    repo.write(`${link}/example/payload`, 'installed');
    const baseline = rows().find((row) => row.task === 'linked');
    expect(baseline?.key).toBeString();
    expect(baseline?.key).not.toBe('');
    const target = join(directory(), 'dependencies');
    cpSync(join(repo.path, link), target, { recursive: true });
    rmSync(join(repo.path, link), { recursive: true });
    symlinkSync(target, join(repo.path, link));
    expect(repo.git('status', '--porcelain', '--untracked-files=all')).toBe(`?? ${link}`);
    const plan = rows();
    const result = cli('run', '--tasks', 'linked');
    expect(result.code, result.err).toBe(0);
    expect(plan.find((row) => row.task === 'linked')).toEqual(baseline);
    expect(plan.find((row) => row.task === 'plain')).toMatchObject({
      state: 'RUN',
      reason: `undecidable: dirty input '${link}'`,
    });
    expect(plan.find((row) => row.task === 'plain')?.key).toBeUndefined();
    expect(result.out).toContain('green linked; proof published');
    expect(rows().find((row) => row.task === 'linked')).toMatchObject({
      key: baseline?.key,
      state: 'PROVEN',
    });
    expect(baseline?.reason).toStartWith('no proof for key');
  });

  test(`declared ${link} excludes descendants but preserves sibling boundaries`, () => {
    const { rows } = fixture(link);
    rmSync(join(repo.path, 'node_modules'), { recursive: true });
    repo.write('.git/info/exclude', '');
    const baseline = rows().find((row) => row.task === 'linked');
    expect(baseline?.key).toBeString();
    repo.write(`${link}/example/payload`, 'installed');
    expect(repo.git('status', '--porcelain', '--untracked-files=all')).toBe(
      `?? ${link}/example/payload`,
    );
    const plan = rows();
    expect(plan.find((row) => row.task === 'linked')).toEqual(baseline);
    expect(plan.find((row) => row.task === 'plain')?.reason).toBe(
      `undecidable: dirty input '${link}/example/payload'`,
    );
    repo.write(`${link}-other/payload`, 'sibling');
    expect(rows().find((row) => row.task === 'linked')?.reason).toBe(
      `undecidable: dirty input '${link}-other/payload'; trusted links: ${link}`,
    );
  });
}

test('a tracked dirty input under a declared link remains undecidable', () => {
  const { rows } = fixture('vendor', 'true', { 'vendor/t.txt': 'committed' });
  const target = directory();
  repo.write('vendor/t.txt', 'changed');
  cpSync(join(repo.path, 'vendor'), target, { recursive: true });
  rmSync(join(repo.path, 'vendor'), { recursive: true });
  symlinkSync(target, join(repo.path, 'vendor'));
  expect(rows().find((row) => row.task === 'linked')).toMatchObject({
    state: 'RUN',
    reason: "undecidable: dirty input 'vendor/t.txt'; trusted links: vendor",
  });
});

test('a node_modules shared with another checkout resolves workspaces to this tree', () => {
  repo = new Repo();
  repo.commit({
    'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    'packages/lib/package.json': JSON.stringify({ name: '@app/lib' }),
    'packages/lib/value': 'main\n',
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'shared-modules',
      generate: {
        run: `printf 'tasks: {%s: {run: "test $(cat node_modules/@app/lib/value) = worktree", inputs: ["**"], links: [node_modules]}}\\n' "$(cat node_modules/@app/lib/value)" > "$PROOF_DECLARATIONS/t.yaml"`,
        inputs: ['**'],
        links: ['node_modules'],
      },
    }),
  });
  mkdirSync(join(repo.path, 'node_modules/@app'), { recursive: true });
  symlinkSync('../../packages/lib', join(repo.path, 'node_modules/@app/lib'));
  const clone = new Repo(repo);
  try {
    clone.commit({ 'packages/lib/value': 'worktree\n' });
    rmSync(join(clone.path, 'node_modules'), { recursive: true });
    symlinkSync(join(repo.path, 'node_modules'), join(clone.path, 'node_modules'));
    const env = { PROOF_STATE_DIR: directory() };
    const plan = clone.cli(['plan', '--json'], env);
    expect(plan.code, plan.err).toBe(0);
    expect(JSON.parse(plan.out)).toMatchObject([{ task: 'worktree' }]);
    expect(clone.cli(['run'], env).code).toBe(0);
  } finally {
    clone.close();
  }
});

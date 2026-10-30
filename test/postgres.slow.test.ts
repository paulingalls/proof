import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const paths: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'proof-postgres-'));
  paths.push(path);
  return path;
}
function fixture(project = 'example') {
  const repo = Repo.from(`postgres:${project}`, (template) =>
    template.commit({
      'proof.yaml': JSON.stringify({
        version: 1,
        project,
        tasks: { lint: { run: 'echo postgres-task-marker', inputs: ['src/**'] } },
      }),
      'src/a.ts': 'a',
    }),
  );
  repos.push(repo);
  return repo;
}
const commands = [['plan'], ['record', 'lint', '--outcome', 'green'], ['run']];

test('present invalid store configuration fails naming its source, never its value', () => {
  const repo = fixture();
  const base = directory();
  for (const value of [
    '',
    'secret-invalid',
    'sqlite://secret',
    'postgres://',
    'postgres://host:99999',
  ]) {
    for (const source of ['env', 'xdg', 'home']) {
      mkdirSync(join(base, 'proof'), { recursive: true });
      mkdirSync(join(base, '.config/proof'), { recursive: true });
      writeFileSync(join(base, 'proof/store'), `${value}\r\nignored`);
      writeFileSync(join(base, '.config/proof/store'), `${value}\nignored`);
      const env = {
        PROOF_STATE_DIR: directory(),
        ...(source === 'env'
          ? { PROOF_STORE: value }
          : source === 'xdg'
            ? { XDG_CONFIG_HOME: base }
            : { HOME: base }),
      };
      for (const args of commands) {
        const result = repo.cli(args, env);
        expect(result.code).toBe(2);
        expect(result.err).toContain(source === 'env' ? 'PROOF_STORE' : 'proof/store');
        if (value) expect(result.err).not.toContain(value);
        expect(result.out).not.toContain('postgres-task-marker');
      }
    }
  }
});

test('invalid environment overrides the file and unreadable configuration fails loudly', () => {
  const repo = fixture();
  const base = directory();
  mkdirSync(join(base, 'proof'), { recursive: true });
  writeFileSync(join(base, 'proof/store'), 'postgres://localhost/example');
  const result = repo.cli(['plan'], {
    PROOF_STATE_DIR: directory(),
    XDG_CONFIG_HOME: base,
    PROOF_STORE: '',
  });
  expect(result.code).toBe(2);
  expect(result.err).toContain('PROOF_STORE');
  rmSync(join(base, 'proof/store'));
  mkdirSync(join(base, 'proof/store'));
  const unreadable = repo.cli(['plan'], { PROOF_STATE_DIR: directory(), XDG_CONFIG_HOME: base });
  expect(unreadable.code).toBe(2);
  expect(unreadable.err).toContain('proof/store');
});

test('the executable does not load store configuration from the repository', () => {
  const repo = fixture();
  repo.write('.env', 'PROOF_STORE=not-a-url\n');
  const result = Bun.spawnSync([new URL('../src/cli.ts', import.meta.url).pathname, 'plan'], {
    cwd: repo.path,
    env: { PATH: process.env.PATH, PROOF_STATE_DIR: directory() },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain('RUN lint');
});

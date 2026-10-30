import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const cli = new URL('../../src/cli.ts', import.meta.url).pathname;

export function isolatedEnv() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
}

export class Repo {
  readonly path = mkdtempSync(join(tmpdir(), 'proof-'));

  constructor(source?: Repo) {
    if (source) this.git('clone', '-q', source.path, '.');
    else this.git('init', '-q');
    this.git('config', 'user.name', 'Proof Test');
    this.git('config', 'user.email', 'proof@example.invalid');
    this.git('config', 'commit.gpgsign', 'false');
    appendFileSync(join(this.path, '.git/info/exclude'), '\n/node_modules/\n');
    this.write('node_modules/example/package.json', '{"name":"example"}');
    this.write('node_modules/example/index.js', 'export default 1;');
    this.write('node_modules/.cache/example', 'cached');
  }

  git(...args: string[]) {
    const result = Bun.spawnSync(['git', ...args], { cwd: this.path, env: isolatedEnv() });
    if (result.exitCode !== 0)
      throw new Error(
        `git ${args.join(' ')}: ${result.stderr.toString()}${result.stdout.toString()}`,
      );
    return result.stdout.toString().trim();
  }

  write(path: string, content: string) {
    const target = join(this.path, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  commit(files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) this.write(path, content);
    this.git('add', '.');
    this.git('commit', '-qm', 'fixture');
    return this.git('rev-parse', 'HEAD');
  }

  check(cases: unknown) {
    this.write('.git/cases.yaml', JSON.stringify(cases));
    return this.cli(['check', '.git/cases.yaml']);
  }

  cli(args: string[], overrides: Record<string, string> = {}) {
    const env: Record<string, string | undefined> = isolatedEnv();
    for (const name of ['PROOF_STATE_DIR', 'XDG_STATE_HOME', 'HOME']) delete env[name];
    const result = Bun.spawnSync([process.execPath, cli, ...args], {
      cwd: this.path,
      env: { ...env, ...overrides },
    });
    return {
      code: result.exitCode,
      out: result.stdout.toString(),
      err: result.stderr.toString(),
    };
  }

  close() {
    rmSync(this.path, { recursive: true, force: true });
  }
}

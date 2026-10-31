import { Database } from 'bun:sqlite';
import { afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider, Task } from '../../src/declarations';
import { Repo } from './repo';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
export function fixture(
  tasks: Record<string, Task>,
  providers: Record<string, Provider> = {},
  files = {},
) {
  const repo = new Repo();
  const directory = () => {
    const path = mkdtempSync(join(tmpdir(), 'proof-jobs-'));
    cleanups.push(() => rmSync(path, { recursive: true, force: true }));
    return path;
  };
  cleanups.push(() => repo.close());
  const env = { PROOF_STATE_DIR: directory(), TMPDIR: directory() };
  repo.commit({
    '.gitignore': '/scratch/\n',
    input: 'original',
    'proof.yaml': JSON.stringify({ version: 1, project: 'jobs', providers, tasks }),
    ...files,
  });
  mkdirSync(join(repo.path, 'scratch'));
  const rows = (table = 'results') => {
    const db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
    // Polling reads race the CLI's commits; a reader without a timeout fails SQLITE_BUSY.
    db.exec('PRAGMA busy_timeout = 5000');
    try {
      return db.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as {
        id: number;
        task: string;
        outcome: string;
        key: string;
        result_id: number;
      }[];
    } finally {
      db.close();
    }
  };
  return {
    repo,
    env,
    rows,
    directory,
    run: (...args: string[]) => repo.cli(['run', ...args], env),
    has: (name: string) => existsSync(join(repo.path, 'scratch', name)),
    read: (name: string) => readFileSync(join(repo.path, 'scratch', name), 'utf8'),
    mark: (name: string) => repo.write(`scratch/${name}`, 'yes'),
  };
}
export const task = (run: string, needs: string[] = []): Task => ({
  run,
  inputs: ['input'],
  links: ['scratch'],
  needs,
});
export const wait = (name: string) => `while ! test -f scratch/${name}; do sleep 0.01; done`;
export async function until(check: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for fixture');
    await Bun.sleep(10);
  }
}
export function spawn(f: ReturnType<typeof fixture>, ...args: string[]) {
  const child = f.repo.spawnCli(['run', ...args], f.env);
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { child, output };
}
export async function stop(child: ReturnType<Repo['spawnCli']>) {
  if (child.exitCode !== null) return;
  child.kill('SIGINT');
  await Bun.sleep(50);
  if (child.exitCode === null) child.kill('SIGINT');
  await until(() => child.exitCode !== null);
  await child.exited;
}
export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return false;
  }
}
export function killGroup(pid: number) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

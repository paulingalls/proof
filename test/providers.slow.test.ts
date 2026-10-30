import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider, Task } from '../src/declarations';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'proof-providers-'));
  dirs.push(path);
  return path;
}
function fixture() {
  const repo = new Repo();
  repos.push(repo);
  const control = directory();
  const env = { PROOF_STATE_DIR: directory(), TMPDIR: directory(), CONTROL: control };
  const mark = (name: string) => `echo ${name} >> '${control}/log'`;
  const task = (run = 'true', inputs = ['input'], needs = ['stack']): Task => ({
    run,
    inputs,
    needs,
  });
  const commit = (
    tasks: Record<string, Task>,
    providers: Record<string, Provider> = {
      stack: { start: mark('start'), stop: mark('stop') },
    },
    files = {},
  ) =>
    repo.commit({
      input: 'original',
      'proof.yaml': JSON.stringify({ version: 1, project: 'providers', providers, tasks }),
      ...files,
    });
  const cli = (...args: string[]) => repo.cli(args, env);
  const seed = (id: string, outcome = 'green') => {
    expect(cli('record', id, '--outcome', outcome).code).toBe(0);
  };
  const log = () =>
    existsSync(join(control, 'log'))
      ? readFileSync(join(control, 'log'), 'utf8').trim().split('\n')
      : [];
  const rows = (table = 'results') => {
    const db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
    try {
      return db.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as {
        task: string;
        outcome: string;
        dirty: number;
        seconds: number | null;
        key: string;
      }[];
    } finally {
      db.close();
    }
  };
  return { repo, env, control, mark, task, commit, cli, seed, log, rows };
}

test('validates root providers and included needs; lifecycle declarations never enter key meaning', () => {
  const f = fixture();
  const tasks = {
    a: f.task(),
    yaml: f.task('true', ['proof.yaml']),
    script: f.task('true', ['start.sh']),
  };
  const providers = { stack: { start: 'true' }, other: { start: 'true' } };
  const before = f.commit(tasks, providers, { 'start.sh': 'true' });
  expect(f.cli('plan').code).toBe(0);
  for (const id of Object.keys(tasks)) f.seed(id);
  tasks.a.needs = ['other'];
  providers.stack.start = 'echo changed';
  const after = f.commit(tasks, providers);
  expect(f.repo.check([{ name: 'meaning', from: before, to: after, expect: ['yaml'] }]).code).toBe(
    0,
  );
  expect(JSON.parse(f.cli('plan', '--json').out).map((r: { state: string }) => r.state)).toEqual([
    'PROVEN',
    'RUN',
    'PROVEN',
  ]);
  const script = f.repo.commit({ 'start.sh': 'echo changed' });
  expect(
    f.repo.check([{ name: 'selected script', from: after, to: script, expect: ['script'] }]).code,
  ).toBe(0);
  f.repo.commit({
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'providers',
      providers,
      include: 'proof.d/*.yaml',
      tasks: {},
    }),
    'proof.d/tasks.yaml': JSON.stringify({ tasks: { included: f.task() } }),
  });
  expect(f.cli('plan').code).toBe(0);
  for (const [providers, needs, message] of [
    [[], ['stack'], 'providers'],
    [{ stack: {} }, ['stack'], 'start'],
    [{ stack: { start: '' } }, ['stack'], 'start'],
    [{ stack: { start: 'true', stop: 1 } }, ['stack'], 'stop'],
    [{ stack: { start: 'true', extra: true } }, ['stack'], 'extra'],
    [{ stack: { start: 'true' } }, 'stack', 'needs'],
    [{ stack: { start: 'true' } }, ['unknown'], 'unknown'],
  ]) {
    f.repo.commit({
      'proof.yaml': JSON.stringify({
        version: 1,
        project: 'providers',
        providers,
        tasks: { a: { run: 'true', inputs: ['input'], needs } },
      }),
    });
    const result = f.cli('plan');
    expect(result.code).toBe(2);
    expect(result.err).toContain(String(message));
  }
});

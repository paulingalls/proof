import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'proof-staged-'));
  dirs.push(dir);
  return dir;
}
function fixture() {
  const repo = new Repo();
  repos.push(repo);
  const control = directory();
  const env = { PROOF_STATE_DIR: directory() };
  const cli = (...args: string[]) => repo.cli(args, env);
  const rows = (table: string) => {
    const db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
    try {
      return db.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[];
    } finally {
      db.close();
    }
  };
  const document = (tasks: unknown, extra = {}) =>
    JSON.stringify({ version: 1, project: 'staged', tasks, ...extra });
  const task = {
    run: `test "$(cat input)" = staged && echo executed >> '${control}/log'`,
    inputs: ['input'],
  };
  repo.commit({ 'proof.yaml': document({ task }), input: 'original' });
  const stage = (files: Record<string, string> = { input: 'staged' }) => {
    for (const [path, bytes] of Object.entries(files)) repo.write(path, bytes);
    repo.git('add', ...Object.keys(files));
  };
  return { repo, control, env, cli, rows, document, task, stage };
}

test('staged green is reused after committing exactly the index', () => {
  const f = fixture();
  const parent = f.repo.git('rev-parse', 'HEAD');
  f.stage();
  const run = f.cli('run', '--staged');
  expect(run.code, run.err).toBe(0);
  expect(run.out).toContain('green task; proof published');
  expect(f.rows('results')).toMatchObject([{ commit: `${parent} (staged)`, outcome: 'green' }]);
  f.repo.git('commit', '-qm', 'staged');
  expect(f.cli('plan').out).toContain('PROVEN task');
  expect(f.cli('run').out).toContain('PROVEN task');
  expect(readFileSync(join(f.control, 'log'), 'utf8')).toBe('executed\n');
  expect(f.rows('results')).toHaveLength(1);
});

test('partial staging ignores untracked inputs and staged deletions left on disk', () => {
  const f = fixture();
  f.repo.commit({
    'proof.yaml': f.document({
      task: {
        ...f.task,
        run: `${f.task.run} && test ! -e extra && test ! -e other && test ! -e deleted`,
        inputs: ['*', '!proof.yaml'],
      },
    }),
    deleted: 'old',
  });
  f.stage();
  f.repo.git('rm', '--cached', 'deleted');
  f.repo.write('input', 'working');
  f.repo.write('extra', 'untracked matching input');
  f.repo.write('other', 'untracked');
  const result = f.cli('run', '--staged');
  expect(result.code, result.out + result.err).toBe(0);
  expect(result.out).toContain('green task; proof published');
  f.repo.git('commit', '-qm', 'index only');
  expect(f.cli('status', '--ref', 'HEAD').out).toContain('PROVEN task');
  expect(f.cli('plan').out).toContain('dirty input');
  for (const path of ['extra', 'other', 'deleted']) rmSync(join(f.repo.path, path));
  f.repo.git('restore', 'input');
  expect(f.cli('plan').out).toContain('PROVEN task');
  expect(f.cli('run').out).toContain('PROVEN task');
  f.repo.commit({ input: 'different' });
  expect(f.cli('plan').out).toContain('RUN task');
});

test('staged declarations, includes, providers and both selectors share the index view', () => {
  const f = fixture();
  const task = { ...f.task, sets: ['commit'], needs: ['service'] };
  f.stage({
    input: 'staged',
    'proof.yaml': f.document(
      { task },
      {
        include: 'staged/*.yaml',
        providers: { service: { start: `echo provider >> '${f.control}/log'` } },
      },
    ),
    'staged/tasks.yaml': JSON.stringify({ tasks: { included: task } }),
  });
  f.repo.write('proof.yaml', f.document({ wrong: { run: 'exit 1', inputs: ['input'] } }));
  f.repo.write('staged/tasks.yaml', JSON.stringify({ tasks: { wrongInclude: task } }));
  f.repo.write('staged/extra.yaml', JSON.stringify({ tasks: { untracked: task } }));
  const run = f.cli('run', '--staged', '--set', 'commit');
  expect(run.code, run.err).toBe(0);
  expect(run.out).toContain('green task; proof published');
  expect(run.out).toContain('green included; proof published');
  expect(run.out).not.toContain('wrong');
  expect(run.out).not.toContain('untracked');
  expect(readFileSync(join(f.control, 'log'), 'utf8')).toBe('provider\nexecuted\nexecuted\n');
  const explicit = f.repo.cli(['run', '--staged', '--tasks', 'included'], {
    PROOF_STATE_DIR: directory(),
  });
  expect(explicit.code, explicit.err).toBe(0);
  expect(explicit.out).toContain('green included; proof published');
  expect(explicit.out).not.toContain('green task');
  f.repo.git('commit', '-qm', 'declarations');
  f.repo.git('restore', 'proof.yaml', 'staged/tasks.yaml');
  rmSync(join(f.repo.path, 'staged/extra.yaml'));
  expect(f.cli('plan', '--set', 'commit').out.match(/PROVEN/g)).toHaveLength(2);
});

test('staged red retains ordinary contest and recovery rules despite checkout dirt', () => {
  const f = fixture();
  f.repo.commit({
    'proof.yaml': f.document({
      task: { ...f.task, run: `${f.task.run} && test ! -e '${f.control}/red'` },
    }),
  });
  f.stage();
  f.repo.write('input', 'working');
  // External control changes execution without changing the task key.
  Bun.write(join(f.control, 'red'), 'red');
  expect(f.cli('run', '--staged').code).toBe(1);
  expect(f.rows('results')).toMatchObject([{ outcome: 'red', dirty: 0 }]);
  rmSync(join(f.control, 'red'));
  expect(f.cli('run', '--staged').code).toBe(0);
  f.repo.git('commit', '-qm', 'target');
  f.repo.git('restore', 'input');
  expect(f.cli('record', 'task', '--outcome', 'red').code).toBe(0);
  f.repo.write('input', 'working');
  Bun.write(join(f.control, 'red'), 'red');
  expect(f.cli('run', '--staged').code).toBe(1);
  expect(f.rows('proofs')).toEqual([]);
  expect(f.rows('contradictions')).toMatchObject([
    { kind: 'ordinary', deleted_proof: 0 },
    { kind: 'ordinary', deleted_proof: 1 },
  ]);
  expect(new Set(f.rows('results').map((row) => row.key)).size).toBe(1);
  rmSync(join(f.control, 'red'));
  expect(f.cli('run', '--staged').code).toBe(0);
  f.repo.git('restore', 'input');
  expect(f.cli('record', 'task', '--outcome', 'red').code).toBe(0);
  f.repo.write('input', 'working');
  expect(f.cli('run', '--staged').out).toContain('green task; proof published');
  expect(f.cli('status', '--ref', 'HEAD').out).toContain('PROVEN task');
});

test('unmerged index fails loudly; staged merge resolution publishes before merge commit', () => {
  const f = fixture();
  f.repo.git('checkout', '-qb', 'side');
  f.repo.commit({ input: 'side' });
  f.repo.git('checkout', '-qb', 'main', 'HEAD~1');
  f.repo.commit({ input: 'main' });
  expect(() => f.repo.git('merge', 'side')).toThrow();
  const conflict = f.cli('run', '--staged');
  expect(conflict.code).toBe(2);
  expect(conflict.err).toContain('input: unmerged');
  f.stage();
  const resolved = f.cli('run', '--staged');
  expect(resolved.code, resolved.err).toBe(0);
  expect(resolved.out).toContain('green task; proof published');
  expect(f.rows('results')).toHaveLength(1);
  f.repo.git('commit', '-qm', 'merge');
  expect(f.cli('plan').out).toContain('PROVEN task');
});

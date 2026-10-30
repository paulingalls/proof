import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../src/declarations';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'proof-run-test-'));
  dirs.push(dir);
  return dir;
}
function fixture(tasks: Record<string, Task>) {
  const repo = Repo.from('run', (r) => r.commit({ 'src/a.ts': 'original' }));
  repos.push(repo);
  repo.commit({ 'proof.yaml': JSON.stringify({ version: 1, project: 'run', tasks }) });
  const env = { PROOF_STATE_DIR: directory(), TMPDIR: directory() };
  return { repo, env, run: (...args: string[]) => repo.cli(['run', ...args], env) };
}
function rows(env: { PROOF_STATE_DIR: string }, table: string) {
  const db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
  try {
    return db.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as {
      task: string;
      outcome: string;
      commit: string;
      dirty: number;
      key: string;
      seconds: number;
      result_id: number;
    }[];
  } finally {
    db.close();
  }
}
function task(run: string, inputs = ['src/a.ts']): Task {
  return { run, inputs };
}

test('runs sequentially, streams without storing output, records captured keys and cleans up', () => {
  const marker = join(directory(), 'marker');
  const { repo, env, run } = fixture({
    ok: task(
      `pwd; echo private-out-token; echo private-err-token >&2; test -f src/a.ts && touch '${marker}'`,
    ),
    bad: task('pwd; exit 1'),
    after: task('pwd; test -f src/a.ts'),
  });
  const commit = repo.git('rev-parse', 'HEAD');
  const result = run();
  expect(result.code).toBe(1);
  expect(result.out).toContain('green ok');
  expect(result.out).toContain('red bad');
  expect(result.out).toContain('green after');
  expect(result.out.indexOf('green ok')).toBeLessThan(result.out.indexOf('red bad'));
  expect(result.out).toContain('private-out-token');
  expect(result.err).toContain('private-err-token');
  const results = rows(env, 'results');
  expect(results.map((r) => [r.task, r.outcome, r.commit, r.dirty])).toEqual([
    ['ok', 'green', commit, 0],
    ['bad', 'red', commit, 0],
    ['after', 'green', commit, 0],
  ]);
  for (const row of results) {
    expect(row.key).toMatch(/^[a-f0-9]{64}$/);
    expect(Number.isFinite(row.seconds) && row.seconds >= 0).toBe(true);
  }
  expect(rows(env, 'proofs').map((r) => r.task)).toEqual(['ok', 'after']);
  expect(readdirSync(env.TMPDIR)).toEqual([]);
  for (const path of result.out.split('\n').filter((s) => s.startsWith(env.TMPDIR)))
    expect(existsSync(path)).toBe(false);
  for (const file of readdirSync(env.PROOF_STATE_DIR)) {
    const contents = readFileSync(join(env.PROOF_STATE_DIR, file)).toString();
    expect(contents).not.toContain('private-out-token');
    expect(contents).not.toContain('private-err-token');
  }
  rmSync(marker);
  const again = run('--tasks', 'ok');
  expect(again.code).toBe(0);
  expect(again.out).toContain('PROVEN ok');
  expect(existsSync(marker)).toBe(false);
  expect(rows(env, 'results')).toHaveLength(3);
});

test('unchanged endpoint guard rejects HEAD moves, selected edits and new dirty paths', () => {
  const { repo, env, run } = fixture({});
  repo.commit({
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'run',
      tasks: {
        move: task(
          `git -C '${repo.path}' -c user.name=t -c user.email=t@example.invalid commit -qm moved --allow-empty`,
        ),
        edit: task(`printf changed > '${repo.path}/src/a.ts'`),
      },
    }),
  });
  const before = repo.git('rev-parse', 'HEAD');
  const result = run();
  expect(result.code).toBe(0);
  expect(result.out).toContain('no proof published: HEAD changed');
  expect(result.out).toContain("no proof published: selected path changed 'src/a.ts'");
  expect(rows(env, 'results').map((r) => [r.task, r.commit, r.dirty])).toEqual([
    ['move', before, 1],
    ['edit', repo.git('rev-parse', 'HEAD'), 1],
  ]);
  expect(rows(env, 'proofs')).toEqual([]);
  repo.commit({
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'run',
      tasks: {
        unrelated: task(`touch '${repo.path}/unrelated'`),
      },
    }),
  });
  const next = run();
  expect(next.code).toBe(0);
  expect(next.out).toContain("no proof published: new dirty path 'unrelated'");
  expect(rows(env, 'proofs')).toEqual([]);
});

test('dirty inputs use working bytes, executable mode, deleted absence and full projection', () => {
  const { repo, env, run } = fixture({
    dirty: {
      run: 'test "$(cat src/a.ts)" = working && ./new.sh && test ! -e deleted && grep full config.json',
      inputs: ['src/a.ts', '*.sh', 'deleted', { path: 'config.json', json: ['key'] }],
    },
    clean: task('test -f clean', ['clean']),
  });
  repo.commit({ 'old.sh': 'true', deleted: 'deleted', 'config.json': '{"key":1}', clean: 'clean' });
  repo.write('src/a.ts', 'staged');
  repo.git('add', 'src/a.ts');
  repo.write('src/a.ts', 'working');
  repo.write('new.sh', '#!/bin/sh\nexit 0\n');
  chmodSync(join(repo.path, 'new.sh'), 0o755);
  rmSync(join(repo.path, 'deleted'));
  repo.write('config.json', '{"key":1,"extra":"full"}');
  const result = run();
  expect(result.code).toBe(0);
  expect(result.out).toContain('green dirty');
  expect(result.out).toContain('undecidable: dirty input');
  expect(result.out).toContain('no proof published: dirty path');
  expect(rows(env, 'results').map((r) => [r.task, r.outcome, r.dirty])).toEqual([
    ['dirty', 'green', 1],
    ['clean', 'green', 1],
  ]);
  expect(rows(env, 'proofs')).toEqual([]);
  expect(readdirSync(env.TMPDIR)).toEqual([]);
});

test('re-decides a previously proven later task after an earlier checkout edit', () => {
  const { repo, env, run } = fixture({});
  repo.commit({
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'run',
      tasks: {
        first: task(`printf changed > '${repo.path}/src/a.ts'`, ['clean']),
        later: task('test "$(cat src/a.ts)" = changed'),
      },
    }),
    clean: 'clean',
  });
  expect(repo.cli(['record', 'later', '--outcome', 'green'], env).code).toBe(0);
  const result = run();
  expect(result.code).toBe(0);
  expect(result.out).not.toContain('PROVEN later');
  expect(result.out).toContain('green later');
  expect(result.out).toContain("undecidable: dirty input 'src/a.ts'");
  expect(rows(env, 'results').map((r) => r.outcome)).toEqual(['green', 'green', 'green']);
});

test('dirty red retains the HEAD proof without a contradiction', () => {
  const { repo, env, run } = fixture({ ok: task('test "$(cat src/a.ts)" = original') });
  expect(repo.cli(['record', 'ok', '--outcome', 'green'], env).code).toBe(0);
  const proof = rows(env, 'proofs');
  repo.write('src/a.ts', 'changed');
  const result = run();
  expect(result.code).toBe(1);
  expect(result.out).toContain('red ok');
  expect(rows(env, 'proofs')).toEqual(proof);
  expect(rows(env, 'contradictions')).toEqual([]);
  expect(rows(env, 'results').map((r) => r.outcome)).toEqual(['green', 'red']);
  repo.git('restore', 'src/a.ts');
  expect(repo.cli(['plan'], env).out).toContain('PROVEN ok');
});

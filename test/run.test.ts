import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
  expect(result.out).toContain('private-err-token');
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
    if (!statSync(join(env.PROOF_STATE_DIR, file)).isFile()) continue;
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
  expect(result.out).toContain('PROVEN later');
  expect(result.out.indexOf('PROVEN later')).toBeLessThan(result.out.indexOf('RUN later'));
  expect(result.out).toContain('green later');
  expect(result.out).toContain("undecidable: dirty input 'src/a.ts'");
  expect(rows(env, 'skips')).toEqual([]);
  expect(rows(env, 'results').map((r) => r.outcome)).toEqual(['green', 'green', 'green']);
});

test('refreshes a dirty closure when its entry changes without changing dirty paths', () => {
  const { repo, env, run } = fixture({});
  repo.commit({
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'run',
      tasks: {
        first: {
          run: `printf "import './new';" > '${repo.path}/entry.ts'`,
          inputs: [{ 'imports-of': 'entry.ts' }],
        },
        later: {
          run: 'test -f new.ts && test ! -e old.ts && grep new entry.ts',
          inputs: [{ 'imports-of': 'entry.ts' }],
        },
      },
    }),
    clean: 'clean',
    'entry.ts': "import './base';",
    'base.ts': 'export const base = 1;',
    'old.ts': 'export const old = 1;',
    'new.ts': 'export const next = 1;',
  });
  repo.write('entry.ts', "import './old';");
  const dirty = repo.git('status', '--porcelain');
  const result = run();
  expect(result.code).toBe(0);
  expect(result.out).toContain("RUN later: undecidable: dirty input 'entry.ts'");
  expect(result.out).toContain('green later; no proof published');
  expect(repo.git('status', '--porcelain')).toBe(dirty);
  expect(rows(env, 'results').map((r) => [r.task, r.outcome, r.dirty])).toEqual([
    ['first', 'green', 1],
    ['later', 'green', 1],
  ]);
  expect(rows(env, 'proofs')).toEqual([]);
});

test('a red contests the head proof when the command removed the dirty input', () => {
  const { repo, env, run } = fixture({});
  repo.commit({
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'run',
      tasks: {
        shadowed: {
          run: `rm '${repo.path}/resolved.tsx'; exit 1`,
          inputs: [{ 'imports-of': 'entry.ts' }],
        },
      },
    }),
    'entry.ts': "import './resolved';",
    'resolved.js': 'export const value = 1;',
  });
  expect(repo.cli(['record', 'shadowed', '--outcome', 'green'], env).code).toBe(0);
  repo.write('resolved.tsx', 'export const value = 2;');
  expect(run().code).toBe(1);
  expect(repo.cli(['plan'], env).out).toContain('RUN shadowed: contested');
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

test('no-key tasks still materialize all available inputs and report unrecorded outcomes', () => {
  const { repo, env, run } = fixture({
    glob: task('test -f src/a.ts && test -f later', ['src/a.ts', 'missing/**', 'later']),
    nofile: { run: 'test ! -e absent.json', inputs: [{ path: 'absent.json', json: ['x'] }] },
    badjson: { run: 'grep invalid invalid.json', inputs: [{ path: 'invalid.json', json: ['x'] }] },
    redless: task('exit 1', ['missing/**']),
  });
  repo.commit({ later: 'later', 'invalid.json': 'invalid' });
  const result = run();
  expect(result.code).toBe(1);
  for (const [id, reason] of [
    ['glob', "unmatched input 'missing/**'"],
    ['nofile', "missing input 'absent.json'"],
    ['badjson', "input 'invalid.json': invalid JSON"],
    ['redless', "unmatched input 'missing/**'"],
  ])
    expect(result.out).toContain(
      `${id === 'redless' ? 'red' : 'green'} ${id}; not recorded: ${reason}`,
    );
  expect(rows(env, 'results')).toEqual([]);
  expect(readdirSync(env.TMPDIR)).toEqual([]);
});

test('sandbox exposes only declared paths and environment names', () => {
  const { repo, env, run } = fixture({
    read: {
      run: 'test ! -e .git && test "$MODE" = selected && test -z "$OTHER" && cat docs/guide.md',
      inputs: ['src/a.ts'],
      env: ['MODE'],
    },
  });
  repo.commit({ 'docs/guide.md': 'guide' });
  const result = repo.cli(['run'], { ...env, MODE: 'selected', OTHER: 'hidden' });
  expect(result.code).toBe(1);
  expect(result.out).toMatch(/docs\/guide.md.*(No such file|no such file)/);
  const doc = JSON.parse(repo.git('show', 'HEAD:proof.yaml'));
  doc.tasks.read.inputs.push('docs/guide.md');
  repo.commit({ 'proof.yaml': JSON.stringify(doc) });
  const next = repo.cli(['run'], { ...env, MODE: 'selected', OTHER: 'hidden' });
  expect(next.code).toBe(0);
  expect(rows(env, 'proofs')).toHaveLength(1);
  const invalid = run('--tasks', 'read', 'nope');
  expect(invalid.code).toBe(2);
  expect(invalid.err).toContain("undeclared task 'nope'");
  expect(rows(env, 'results')).toHaveLength(2);
});

test('refuses selected symlinks without recording and removes the sandbox', () => {
  const { repo, env, run } = fixture({ link: task('cat link', ['link']) });
  symlinkSync('src/a.ts', join(repo.path, 'link'));
  repo.commit({});
  const result = run();
  expect(result.code).toBe(2);
  expect(result.err).toContain("selected path 'link': symlink");
  expect(rows(env, 'results')).toEqual([]);
  expect(readdirSync(env.TMPDIR)).toEqual([]);
});

test('preserves raw blobs and executable modes; a mode-only commit invalidates proof', () => {
  const { repo, env, run } = fixture({
    bytes: {
      run: './script.sh && grep full config.json',
      inputs: ['script.sh', 'binary', { path: 'config.json', json: ['key'] }],
    },
  });
  repo.write('script.sh', '#!/bin/sh\nprintf "\\000\\377\\200a" | cmp - binary\n');
  chmodSync(join(repo.path, 'script.sh'), 0o755);
  writeFileSync(join(repo.path, 'binary'), Buffer.from([0, 255, 128, 97]));
  const before = repo.commit({ 'config.json': '{"key":1,"extra":"full"}' });
  expect(run().code).toBe(0);
  expect(rows(env, 'proofs')).toHaveLength(1);
  chmodSync(join(repo.path, 'config.json'), 0o755);
  const projectedMode = repo.commit({});
  chmodSync(join(repo.path, 'script.sh'), 0o644);
  const after = repo.commit({});
  const checked = repo.check([
    { name: 'projection mode', from: before, to: projectedMode, expect: ['bytes'] },
    { name: 'script mode', from: projectedMode, to: after, expect: ['bytes'] },
  ]);
  expect(checked.code).toBe(0);
  const result = run();
  expect(result.code).toBe(1);
  expect(result.out).toContain('red bytes');
});

test('staged root and dirty includes execute working declarations without records or contests', () => {
  const { repo, env, run } = fixture({ old: task('exit 0') });
  expect(repo.cli(['record', 'old', '--outcome', 'green'], env).code).toBe(0);
  repo.write(
    'proof.yaml',
    JSON.stringify({
      version: 1,
      project: 'run',
      include: 'proof.d/*.yaml',
      tasks: {
        old: task('exit 1'),
        new: task('echo staged-new'),
      },
    }),
  );
  repo.git('add', 'proof.yaml');
  repo.write(
    'proof.d/extra.yaml',
    JSON.stringify({ tasks: { included: task('echo working-include') } }),
  );
  const planned = repo.cli(['plan', '--json'], env);
  expect(planned.code).toBe(0);
  expect(JSON.parse(planned.out).map((r: { task: string }) => r.task)).toEqual([
    'old',
    'new',
    'included',
  ]);
  const result = run();
  expect(result.code).toBe(1);
  expect(result.out).toContain('staged-new');
  expect(result.out).toContain('working-include');
  for (const id of ['old', 'new', 'included'])
    expect(result.out).toContain(`${id}; not recorded: dirty declaration`);
  expect(rows(env, 'results')).toHaveLength(1);
  expect(rows(env, 'contradictions')).toEqual([]);
  expect(readdirSync(env.TMPDIR)).toEqual([]);
});

test('runs from a subdirectory as from the repo root', () => {
  const { repo, env } = fixture({ ok: task('test "$(cat src/a.ts)" = working', ['src/a.ts']) });
  repo.write('sub/keep', 'x');
  repo.write('src/a.ts', 'working');
  const result = repo.cli(['run'], env, join(repo.path, 'sub'));
  expect(result.out).toContain('green ok');
  expect(result.out).toContain("no proof published: dirty path 'src/a.ts'");
  expect(result.code).toBe(0);
});

test('a removed included declaration runs the working declarations', () => {
  const { repo, env, run } = fixture({ root: task('exit 0') });
  repo.commit({
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'run',
      include: 'proof.d/*.yaml',
      tasks: {},
    }),
    'proof.d/old.yaml': JSON.stringify({ tasks: { old: task('exit 0') } }),
    'proof.d/keep.yaml': JSON.stringify({ tasks: { keep: task('exit 0') } }),
  });
  repo.git('rm', '-q', 'proof.d/old.yaml');
  const planned = repo.cli(['plan', '--json'], env);
  expect(planned.code).toBe(0);
  expect(JSON.parse(planned.out).map((r: { task: string }) => r.task)).toEqual(['keep']);
  expect(run().out).toContain('keep; not recorded: dirty declaration');
});

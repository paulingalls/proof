import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const states: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const path of states.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture(tasks: object, extra = {}) {
  const repo = new Repo();
  repos.push(repo);
  repo.commit({
    'proof.yaml': JSON.stringify({ version: 1, project: 'overhead', tasks, ...extra }),
    '.gitignore': 'cache/\n',
    'a.txt': 'tracked',
    'cache/keep.txt': 'excluded',
  });
  repo.git('add', '-f', 'cache/keep.txt');
  repo.git('commit', '-qm', 'tracked exclusion');
  const state = mkdtempSync(join(tmpdir(), 'proof-overhead-'));
  states.push(state);
  const trace = join(repo.path, '.git/trace');
  return { repo, trace, env: { PROOF_STATE_DIR: state, GIT_TRACE: trace } };
}
const inputs = ['**/*.txt', '!cache/**'];
function calls(trace: string, pattern: RegExp) {
  return readFileSync(trace, 'utf8').match(pattern) ?? [];
}
const ignored = /git ls-files .*--ignored/g;
const status = /git status --porcelain=v1/g;

for (const jobs of [1, 2]) {
  test(`run inventories ignored paths once and checks status per executed task, jobs=${jobs}`, () => {
    const { repo, trace, env } = fixture({
      a: { run: 'true', inputs },
      b: { run: 'true', inputs },
      c: { run: 'true', inputs },
    });
    for (let i = 0; i < 256; i++) repo.write(`cache/${i % 8}/${i}.txt`, 'ignored');
    const result = repo.cli(['run', '--jobs', String(jobs)], env);
    expect(result.code, result.err + result.out).toBe(0);
    for (const id of ['a', 'b', 'c']) expect(result.out).toContain(`green ${id}; proof published`);
    expect(calls(trace, ignored)).toHaveLength(1);
    expect(calls(trace, status)).toHaveLength(4);
    writeFileSync(trace, '');
    const warm = repo.cli(['run', '--jobs', String(jobs)], env);
    expect(warm.code, warm.err + warm.out).toBe(0);
    for (const id of ['a', 'b', 'c']) expect(warm.out).toContain(`PROVEN ${id}`);
    expect(calls(trace, ignored)).toHaveLength(1);
    expect(calls(trace, status)).toHaveLength(1);
  });
}

test('startup ignored selection matches plan and supplies working bytes', () => {
  const { repo, trace, env } = fixture({
    a: { run: 'test "$(cat cache/input.txt)" = working', inputs: ['a.txt', 'cache/*.txt'] },
  });
  repo.write('cache/input.txt', 'working');
  repo.write('cache/excluded.bin', 'irrelevant');
  const plan = repo.cli(['plan'], env);
  expect(plan.code, plan.err).toBe(0);
  expect(plan.out).toContain("dirty input 'cache/input.txt'");
  writeFileSync(trace, '');
  const result = repo.cli(['run'], env);
  expect(result.code, result.err + result.out).toBe(0);
  expect(result.out.startsWith(plan.out)).toBe(true);
  expect(result.out).toContain('green a; no proof published:');
  expect(calls(trace, ignored)).toHaveLength(1);
});

for (const jobs of [1, 2]) {
  for (const fail of [false, true]) {
    test(`provider refreshes ignored selection once, jobs=${jobs}, failed=${fail}`, () => {
      const task = {
        run: 'test "$(cat cache/input.txt)" = provider',
        inputs: ['a.txt', 'cache/*.txt'],
        needs: ['setup'],
      };
      const { repo, trace, env } = fixture(
        { a: task, b: task },
        {
          providers: {
            setup: { start: `echo provider > cache/input.txt; ${fail ? 'false' : 'true'}` },
          },
        },
      );
      const result = repo.cli(['run', '--jobs', String(jobs)], env);
      expect(result.code, result.err + result.out).toBe(fail ? 1 : 0);
      for (const id of ['a', 'b']) {
        expect(result.out).toContain(`RUN ${id}: undecidable: dirty input 'cache/input.txt'`);
        expect(result.out).toContain(`${fail ? 'incomplete' : 'green'} ${id}; no proof published:`);
      }
      expect(result.out).not.toContain('; proof published');
      expect(calls(trace, ignored)).toHaveLength(2);
    });
  }
}

test('a new commit reselects ignored inputs for later tasks', () => {
  const { repo, trace, env } = fixture({
    move: { run: 'true', inputs: ['a.txt'] },
    later: { run: 'test "$(cat cache/input.txt)" = working', inputs: ['a.txt'] },
  });
  const doc = JSON.parse(repo.git('show', 'HEAD:proof.yaml'));
  doc.tasks.later.inputs.push('cache/*.txt');
  repo.write('.git/next.json', JSON.stringify(doc));
  const next = join(repo.path, '.git/next.json');
  doc.tasks.later.inputs = ['a.txt'];
  doc.tasks.move.run = `git -C '${repo.path}' show HEAD:a.txt >/dev/null && cp '${next}' '${repo.path}/proof.yaml' && git -C '${repo.path}' add proof.yaml && git -C '${repo.path}' commit -qm scope`;
  repo.commit({ 'proof.yaml': JSON.stringify(doc) });
  repo.write('cache/input.txt', 'working');
  const result = repo.cli(['run'], env);
  expect(result.code, result.err + result.out).toBe(0);
  expect(result.out).toContain('green move; no proof published: HEAD changed');
  expect(result.out).toContain("RUN later: undecidable: dirty input 'cache/input.txt'");
  expect(result.out).toContain('green later; no proof published:');
  expect(calls(trace, ignored)).toHaveLength(2);
  const plan = repo.cli(['plan'], env);
  expect(plan.code, plan.err).toBe(0);
  expect(plan.out).toContain("RUN later: undecidable: dirty input 'cache/input.txt'");
});

test('sandbox batches committed blobs and preserves bytes, modes and selected symlinks', () => {
  const { repo, trace, env } = fixture({
    a: {
      run: `for i in $(seq 0 31); do test "$(cat data/$i.bin)" = bytes || exit 1; done &&
        test "$(od -An -tx1 data/raw.bin | tr -d ' \\n')" = 00ff01 &&
        test -x data/exec.bin && test ! -x data/0.bin &&
        test -L data/link.bin && test "$(cat data/link.bin)" = bytes`,
      inputs: ['data/**'],
    },
  });
  for (let i = 0; i < 32; i++) repo.write(`data/${i}.bin`, 'bytes');
  repo.write('data/raw.bin', '');
  writeFileSync(join(repo.path, 'data/raw.bin'), Buffer.from([0, 255, 1]));
  repo.write('data/exec.bin', '#!/bin/sh\nexit 0\n');
  chmodSync(join(repo.path, 'data/exec.bin'), 0o755);
  symlinkSync('0.bin', join(repo.path, 'data/link.bin'));
  repo.commit({});
  const ids = ['data/0.bin', 'data/raw.bin', 'data/exec.bin', 'data/link.bin'].map((path) =>
    repo.git('rev-parse', `HEAD:${path}`),
  );
  const result = repo.cli(['run'], env);
  expect(result.code, result.err + result.out).toBe(0);
  expect(result.out).toContain('green a; proof published');
  expect(calls(trace, /git cat-file --batch/g)).toHaveLength(1);
  const text = readFileSync(trace, 'utf8');
  for (const id of ids) expect(text).not.toContain(`git cat-file blob ${id}`);
});

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
  test(`run never lists ignored paths and checks status per executed task, jobs=${jobs}`, () => {
    const { repo, trace, env } = fixture({
      a: { run: 'true', inputs },
      b: { run: 'true', inputs },
      c: { run: 'true', inputs },
    });
    for (let i = 0; i < 4; i++) repo.write(`cache/${i % 8}/${i}.txt`, 'ignored');
    const result = repo.cli(['run', '--jobs', String(jobs)], env);
    expect(result.code, result.err + result.out).toBe(0);
    for (const id of ['a', 'b', 'c']) expect(result.out).toContain(`green ${id}; proof published`);
    expect(calls(trace, ignored)).toHaveLength(0);
    expect(calls(trace, status)).toHaveLength(4);
    writeFileSync(trace, '');
    const warm = repo.cli(['run', '--jobs', String(jobs)], env);
    expect(warm.code, warm.err + warm.out).toBe(0);
    for (const id of ['a', 'b', 'c']) expect(warm.out).toContain(`PROVEN ${id}`);
    expect(calls(trace, ignored)).toHaveLength(0);
    expect(calls(trace, status)).toHaveLength(1);
    expect(calls(trace, /git ls-files -v/g).length).toBeGreaterThan(0);
  });
}

test('ignored glob matches leave keys, publication and sandbox unchanged', () => {
  const { repo, env } = fixture({
    a: {
      run: 'test "$(cat cache/keep.txt)" = excluded && test ! -e cache/input.txt',
      inputs: ['a.txt', 'cache/*.txt'],
    },
  });
  const rows = () => JSON.parse(repo.cli(['plan', '--json'], env).out);
  const baseline = rows();
  repo.write('cache/input.txt', 'ignored');
  expect(rows()).toEqual(baseline);
  const result = repo.cli(['run'], env);
  expect(result.code, result.err + result.out).toBe(0);
  expect(result.out).toContain('green a; proof published');
  repo.write('cache/input.txt', 'changed');
  expect(rows()[0]).toMatchObject({ state: 'PROVEN', key: baseline[0].key });
  expect(repo.cli(['run'], env).out).toContain('PROVEN a');
  expect(repo.cli(['record', 'a', '--outcome', 'green'], env).out).toContain('proof published');
  expect(rows()[0].key).toBe(baseline[0].key);
});

test('ignored literals are missing while extglobs remain unmatched globs', () => {
  const { repo, env } = fixture({
    literal: { run: 'test ! -e cache/input.txt', inputs: ['cache/input.txt'] },
    glob: { run: 'true', inputs: ['cache/@(absent|other).txt'] },
  });
  repo.write('cache/input.txt', 'ignored');
  const rows = JSON.parse(repo.cli(['plan', '--json'], env).out);
  expect(rows[0]).toEqual({
    task: 'literal',
    state: 'RUN',
    reason: "undecidable: missing input 'cache/input.txt'",
  });
  expect(rows[1].reason).toBe("undecidable: unmatched input 'cache/@(absent|other).txt'");
  const result = repo.cli(['run', '--tasks', 'literal'], env);
  expect(result.code, result.err + result.out).toBe(0);
  expect(result.out).toContain("green literal; not recorded: missing input 'cache/input.txt'");
});

for (const fail of [false, true]) {
  test(`provider ignored output stays outside the sandbox, failed=${fail}`, () => {
    const { repo, trace, env } = fixture(
      {
        a: { run: 'test ! -e cache/input.txt', inputs: ['a.txt', 'cache/*.txt'], needs: ['setup'] },
      },
      {
        providers: {
          setup: { start: `echo provider > cache/input.txt; ${fail ? 'false' : 'true'}` },
        },
      },
    );
    const result = repo.cli(['run'], env);
    expect(result.code, result.err + result.out).toBe(fail ? 1 : 0);
    expect(result.out).toContain(fail ? 'incomplete a' : 'green a; proof published');
    if (fail) expect(result.out).not.toContain('; proof published');
    expect(calls(trace, ignored)).toHaveLength(0);
  });
}

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

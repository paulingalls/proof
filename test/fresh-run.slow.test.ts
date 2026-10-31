import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { output, Postgres, waitFor } from './support/postgres';
import { Repo } from './support/repo';

type Row = {
  id: number | string;
  result_id: number | string;
  task: string;
  key: string;
  outcome: string;
  dirty: number;
};

const postgres = new Postgres(true);
beforeAll(async () => {
  await postgres.start();
}, 120_000);
afterAll(async () => {
  await postgres.close();
});
const repos: Repo[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'proof-fresh-'));
  dirs.push(dir);
  return dir;
}
function fixture(remote = '') {
  const repo = new Repo();
  repos.push(repo);
  const control = directory();
  const env = {
    PROOF_STATE_DIR: directory(),
    TMPDIR: directory(),
    ...(remote ? { PROOF_STORE: remote } : {}),
  };
  const cli = (...args: string[]) => repo.cli(args, env);
  const rows = (table: string) => {
    const db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
    try {
      return db.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[];
    } finally {
      db.close();
    }
  };
  const commit = (tasks: unknown, files = {}) =>
    repo.commit({
      'proof.yaml': JSON.stringify({ version: 1, project: 'fresh', tasks }),
      input: 'original',
      ...files,
    });
  const seed = (id: string, outcome = 'green') =>
    expect(cli('record', id, '--outcome', outcome).code).toBe(0);
  return { repo, control, env, cli, rows, commit, seed };
}

for (const remote of [false, true]) {
  test(`fresh continues after red and deletes only its proof; remote=${remote}`, async () => {
    const database = remote ? await postgres.database() : undefined;
    const f = fixture(database?.PROOF_STORE);
    f.commit({
      first: {
        run: `test -f input && test ! -e .git && echo first; test ! -e '${f.control}/red'`,
        inputs: ['input'],
      },
      second: { run: 'test -f input && test ! -e .git && echo second', inputs: ['input'] },
    });
    expect(f.cli('run').code).toBe(0);
    const before = f.rows('results');
    writeFileSync(join(f.control, 'red'), 'red');
    const result = f.cli('run', '--fresh');
    expect(result.code).toBe(1);
    expect(result.out).toContain('RUN first: fresh');
    expect(result.out).not.toContain('PROVEN');
    expect(result.out).toContain('red first');
    expect(result.out).toContain('green second; proof published');
    const after = f.rows('results');
    expect(after.map((r) => r.outcome)).toEqual(['green', 'green', 'red', 'green']);
    expect(after.slice(2).map((r) => r.key)).toEqual(before.map((r) => r.key));
    const check = (proofs: Row[], contradictions: Row[], results: Row[]) => {
      expect(proofs.map((r) => r.task)).toEqual(['second']);
      expect(proofs[0]?.result_id).toBe(results[3]?.id);
      expect(contradictions).toMatchObject([
        {
          task: 'first',
          kind: 'super',
          deleted_proof: 1,
          green_result: results[0]?.id,
          red_result: results[2]?.id,
        },
      ]);
    };
    check(f.rows('proofs'), f.rows('contradictions'), after);
    expect(result.out).toContain(`deleted proof local first ${before[0]?.key}`);
    expect(result.out).not.toContain('deleted proof local second');
    if (database) {
      check(
        await database.sql`SELECT * FROM proofs`,
        await database.sql`SELECT * FROM contradictions`,
        await database.sql`SELECT * FROM results ORDER BY id`,
      );
      expect(result.out).toContain(`deleted proof shared first ${before[0]?.key}`);
    }
  }, 30_000);

  test(`fresh dirty input cannot delete, unrelated dirt can; remote=${remote}`, async () => {
    const database = remote ? await postgres.database() : undefined;
    const f = fixture(database?.PROOF_STORE);
    f.commit({
      task: {
        run: `test ! -e '${f.control}/red' && test "$(cat input)" = original`,
        inputs: ['input'],
      },
    });
    f.seed('task');
    const proofs = f.rows('proofs');
    f.repo.write('input', 'changed');
    const dirty = f.cli('run', '--fresh');
    expect(dirty.code).toBe(1);
    expect(dirty.out).not.toContain('deleted proof');
    expect(f.rows('proofs')).toEqual(proofs);
    expect(f.rows('contradictions')).toEqual([]);
    f.repo.git('restore', 'input');
    expect(f.cli('plan').out).toContain('PROVEN task');
    f.repo.write('unrelated', 'dirty');
    const green = f.cli('run', '--fresh');
    expect(green.code).toBe(0);
    expect(green.out).toContain('green task; no proof published: dirty path');
    expect(f.rows('proofs')).toEqual(proofs);
    writeFileSync(join(f.control, 'red'), 'red');
    const red = f.cli('run', '--fresh');
    expect(red.code).toBe(1);
    expect(red.out).toContain('deleted proof local task');
    expect(f.rows('results').map((r) => r.dirty)).toEqual([0, 1, 1, 1]);
    expect(f.rows('proofs')).toEqual([]);
    expect(f.rows('contradictions')).toMatchObject([{ kind: 'super', deleted_proof: 1 }]);
    if (database) {
      expect(await database.sql`SELECT * FROM proofs`).toEqual([]);
      expect(await database.sql`SELECT kind, deleted_proof FROM contradictions`).toEqual([
        { kind: 'super', deleted_proof: 1 },
      ]);
    }
  }, 30_000);
}

test('fresh captures dirty closure eligibility before a command removes its shadow', () => {
  const f = fixture();
  f.commit(
    {
      task: {
        run: `rm '${f.repo.path}/resolved.tsx'; exit 1`,
        inputs: [{ 'imports-of': 'entry.ts' }],
      },
    },
    { 'entry.ts': "import './resolved';", 'resolved.js': 'export const value = 1;' },
  );
  f.seed('task');
  const proofs = f.rows('proofs');
  f.repo.write('resolved.tsx', 'export const value = 2;');
  const red = f.cli('run', '--fresh');
  expect(red.code).toBe(1);
  expect(red.out).toContain('undecidable: dirty input');
  expect(red.out).not.toContain('deleted proof');
  expect(f.rows('proofs')).toEqual(proofs);
  expect(f.rows('contradictions')).toEqual([]);
  expect(f.cli('plan').out).toContain('PROVEN task');
});

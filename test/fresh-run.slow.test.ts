import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
      expect([...contradictions]).toMatchObject([
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
    if (database) {
      expect(await database.sql`SELECT * FROM proofs`).toHaveLength(1);
      expect(await database.sql`SELECT * FROM contradictions`).toHaveLength(0);
    }
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

test('a task whose sandbox cannot be built fails alone in fresh and aborts ordinary run', () => {
  const repo = new Repo();
  repos.push(repo);
  const env = { PROOF_STATE_DIR: directory(), TMPDIR: directory() };
  symlinkSync('a.txt', join(repo.path, 'link'));
  repo.commit({
    'a.txt': 'a',
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'fresh',
      tasks: {
        broken: { run: 'true', inputs: ['link'] },
        later: { run: 'true', inputs: ['a.txt'] },
        unproven: { run: 'echo unproven', inputs: ['link'] },
      },
    }),
  });
  expect(repo.cli(['record', 'broken', '--outcome', 'green'], env).code).toBe(0);
  const fresh = repo.cli(['run', '--fresh'], env);
  expect(fresh.code).toBe(1);
  expect(fresh.out).toContain('incomplete broken; sandbox failed: ');
  expect(fresh.out).toContain('green later; proof published');
  expect(repo.cli(['plan'], env).out).toContain('PROVEN broken');
  expect(repo.cli(['run', '--tasks', 'unproven'], env).code).toBe(2);
}, 30_000);

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

test('fresh green resolves a remote contest without removing its history', async () => {
  const database = await postgres.database();
  const f = fixture(database.PROOF_STORE);
  f.commit({ task: { run: 'true', inputs: ['input'] } });
  const clone = new Repo(f.repo);
  repos.push(clone);
  const other = { PROOF_STORE: database.PROOF_STORE, PROOF_STATE_DIR: directory() };
  f.seed('task');
  expect(clone.cli(['record', 'task', '--outcome', 'red'], other).code).toBe(0);
  expect(f.cli('plan').out).toContain('RUN task: contested');
  const green = f.cli('run', '--fresh', '--tasks', 'task');
  expect(green.code).toBe(0);
  expect(green.out).toContain('green task; proof published; shared');
  expect(green.out).not.toContain('deleted proof');
  for (const result of [f.cli('plan'), clone.cli(['plan'], other)])
    expect(result.out).toContain('PROVEN task');
  expect(await database.sql`SELECT kind, deleted_proof FROM contradictions`).toEqual([
    { kind: 'ordinary', deleted_proof: 0 },
  ]);
}, 30_000);

test('store owns deletion when a second clone publishes after fresh preview', async () => {
  const database = await postgres.database();
  const f = fixture(database.PROOF_STORE);
  const ready = join(f.control, 'ready');
  const release = join(f.control, 'release');
  f.commit({
    task: {
      run: `touch '${ready}'; while ! test -e '${release}'; do sleep 0.02; done; exit 1`,
      inputs: ['input'],
    },
  });
  const clone = new Repo(f.repo);
  repos.push(clone);
  const other = { PROOF_STORE: database.PROOF_STORE, PROOF_STATE_DIR: directory() };
  const child = f.repo.spawnCli(['run', '--fresh'], f.env);
  const done = output(child);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try {
    await waitFor(async () => existsSync(ready));
    expect(clone.cli(['record', 'task', '--outcome', 'green'], other).code).toBe(0);
    const [proof] = await database.sql`SELECT key FROM proofs`;
    writeFileSync(release, 'go');
    const red = await done;
    expect(red.code).toBe(1);
    expect(red.out).toContain(`deleted proof shared task ${proof.key}`);
    expect(red.out).not.toContain('deleted proof local');
    expect(f.rows('contradictions')).toEqual([]);
    expect(await database.sql`SELECT kind, deleted_proof FROM contradictions`).toEqual([
      { kind: 'super', deleted_proof: 1 },
    ]);
    expect(await database.sql`SELECT * FROM proofs`).toEqual([]);
  } finally {
    clearTimeout(timeout);
    child.kill('SIGKILL');
    await child.exited;
    await done;
  }
}, 30_000);

test('another clone observes a super deletion and remembers it offline', async () => {
  const database = await postgres.database();
  const f = fixture(database.PROOF_STORE);
  f.commit({ task: { run: 'exit 1', inputs: ['input'] } });
  const clone = new Repo(f.repo);
  repos.push(clone);
  const other = { PROOF_STORE: database.PROOF_STORE, PROOF_STATE_DIR: directory() };
  f.seed('task');
  const red = clone.cli(['run', '--fresh'], other);
  expect(red.code).toBe(1);
  expect(red.out).toContain('deleted proof shared task');
  expect(red.out).not.toContain('deleted proof local');
  expect(f.cli('plan').out).toContain('RUN task');
  expect(f.rows('results')).toHaveLength(1);
  expect(f.rows('proofs')).toHaveLength(1);
  expect(await database.sql`SELECT * FROM proofs`).toHaveLength(0);
  postgres.stop();
  try {
    const offline = f.cli('plan');
    expect(offline.out).toContain('RUN task: contested');
    expect(offline.err.match(/using this machine/g)).toHaveLength(1);
    expect(f.rows('results')).toHaveLength(1);
  } finally {
    await postgres.restart();
  }
}, 30_000);

test('offline fresh red deletes locally and vetoes a still-green remote until clean fresh green', async () => {
  const database = await postgres.database();
  const f = fixture(database.PROOF_STORE);
  f.commit({ task: { run: `test ! -e '${f.control}/red'`, inputs: ['input'] } });
  f.seed('task');
  writeFileSync(join(f.control, 'red'), 'red');
  postgres.stop();
  try {
    const red = f.cli('run', '--fresh');
    expect(red.code).toBe(1);
    expect(red.out).toContain('red task; not shared');
    expect(red.out).toContain('deleted proof local task');
    expect(red.out).not.toContain('deleted proof shared');
    expect(red.err.match(/using this machine/g)).toHaveLength(1);
    expect(f.rows('proofs')).toEqual([]);
    expect(f.rows('contradictions')).toMatchObject([{ kind: 'super', deleted_proof: 1 }]);
    expect(f.cli('plan').out).toContain('RUN task');
  } finally {
    await postgres.restart();
  }
  const blocked = () => expect(f.cli('plan').out).toContain('RUN task: contested');
  blocked();
  const other = { PROOF_STORE: database.PROOF_STORE, PROOF_STATE_DIR: directory() };
  expect(f.repo.cli(['plan'], other).out).toContain('PROVEN task');
  expect(await database.sql`SELECT * FROM results`).toHaveLength(1);
  f.seed('task', 'incomplete');
  blocked();
  rmSync(join(f.control, 'red'));
  f.repo.write('unrelated', 'dirty');
  const dirty = f.cli('run', '--fresh');
  expect(dirty.code).toBe(0);
  expect(dirty.out).toContain('no proof published: dirty path');
  expect(f.rows('proofs')).toEqual([]);
  blocked();
  rmSync(join(f.repo.path, 'unrelated'));
  expect(f.cli('run', '--fresh').code).toBe(0);
  expect(f.cli('plan').out).toContain('PROVEN task');
  expect(f.rows('unshared_reds')).toEqual([]);
}, 30_000);

test('lost shared commit reports local deletion only and preserves its veto', async () => {
  const database = await postgres.database();
  const f = fixture(database.PROOF_STORE);
  f.commit({ task: { run: 'exit 1', inputs: ['input'] } });
  f.seed('task');
  await database.sql.unsafe(`CREATE FUNCTION block_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(123456); RETURN NEW; END $$;
    CREATE CONSTRAINT TRIGGER block_commit AFTER INSERT ON results
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION block_commit()`);
  const locker = postgres.connect(database.PROOF_STORE);
  await locker`SELECT pg_advisory_lock(123456)`;
  const child = f.repo.spawnCli(['run', '--fresh'], f.env);
  const done = output(child);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try {
    await waitFor(
      async () =>
        (
          await database.sql`SELECT 1 FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted`
        ).length === 1,
    );
    expect(f.rows('proofs')).toHaveLength(0);
    const [waiting] = await database.sql`SELECT pid FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted`;
    await database.sql`SELECT pg_terminate_backend(${waiting.pid})`;
    const red = await done;
    expect(red.code).toBe(1);
    expect(red.out).toContain('sharing uncertain');
    expect(red.out).toContain('deleted proof local task');
    expect(red.out).not.toContain('deleted proof shared');
    expect(await database.sql`SELECT * FROM proofs`).toHaveLength(1);
    expect(await database.sql`SELECT * FROM contradictions`).toHaveLength(0);
    expect(f.cli('plan').out).toContain('RUN task: contested');
  } finally {
    clearTimeout(timeout);
    await locker`SELECT pg_advisory_unlock(123456)`;
    child.kill('SIGKILL');
    await child.exited;
    await done;
  }
}, 30_000);

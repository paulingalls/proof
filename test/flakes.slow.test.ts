import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { output, Postgres, waitFor } from './support/postgres';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const paths: string[] = [];
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const repo of repos.splice(0)) repo.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'proof-flakes-'));
  paths.push(path);
  return path;
}
function fixture(project = 'flakes') {
  const repo = Repo.from(`flakes:${project}`, (template) =>
    template.commit({
      'proof.yaml': JSON.stringify({
        version: 1,
        project,
        tasks: {
          a: { run: 'exit 1', inputs: ['src/**'] },
          b: { run: 'true', inputs: ['src/**'] },
        },
      }),
      'src/a': 'one',
    }),
  );
  repos.push(repo);
  const env = { PROOF_STATE_DIR: directory() };
  const cli = (args: string[]) => repo.cli(args, env);
  expect(cli(['plan']).code).toBe(0);
  const db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
  databases.push(db);
  const record = (task: string, outcome: string) => {
    expect(cli(['record', task, '--outcome', outcome, '--seconds', '20']).code).toBe(0);
  };
  return { repo, env, cli, db, record };
}

test('flakes ranks ordinary counts, separates super, scopes project and calendar window', () => {
  const { cli, db, record, env } = fixture();
  expect(cli(['flakes'])).toEqual({ code: 0, out: 'no contradictions in 30d\n', err: '' });
  for (const task of ['a', 'a', 'a', 'b']) {
    record(task, 'green');
    record(task, 'red');
  }
  record('a', 'green');
  expect(cli(['run', '--fresh', '--tasks', 'a']).code).toBe(1);
  expect(cli(['flakes']).out).toBe('ordinary task super\n3 a 1\n1 b 0\n');
  expect(cli(['invalidate', '--task', 'b']).code).toBe(0);
  expect(cli(['flakes']).out).toBe('ordinary task super\n3 a 1\n1 b 0\n');
  const other = fixture('other');
  for (const outcome of ['green', 'red'])
    expect(other.repo.cli(['record', 'b', '--outcome', outcome], env).code).toBe(0);
  const ago = (days: number) => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).toISOString();
  };
  db.query("UPDATE contradictions SET recorded_at = ? WHERE task = 'a' AND kind = 'ordinary'").run(
    ago(40),
  );
  db.query("UPDATE contradictions SET recorded_at = ? WHERE task = 'b'").run(ago(10));
  expect(cli(['flakes']).out).toBe('ordinary task super\n1 b 0\n0 a 1\n');
  expect(cli(['flakes', '--since', '7d']).out).toBe('ordinary task super\n0 a 1\n');
  db.query("UPDATE contradictions SET recorded_at = ? WHERE kind = 'super'").run(ago(40));
  expect(cli(['flakes', '--since', '7d']).out).toBe('no contradictions in 7d\n');
}, 30_000);

test('manual deletion audits atomically, restores cleanly and leaves stats and flakes alone', () => {
  const { cli, db, record, repo } = fixture();
  expect(cli(['run', '--tasks', 'b']).code).toBe(0);
  const before = cli(['stats']).out.split('\n')[1];
  const proof = db.query('SELECT * FROM proofs').get() as { result_id: number; key: string };
  const commit = repo.git('rev-parse', 'HEAD');
  repo.write('src/a', 'dirty bytes do not change HEAD invalidation');
  expect(cli(['invalidate', '--task', 'b'])).toEqual({
    code: 0,
    out: 'deleted 1 proof(s)\n',
    err: '',
  });
  repo.git('checkout', '--', 'src/a');
  expect(cli(['plan']).out).toContain('RUN b:');
  const audit = db
    .query(`SELECT c.*, r.outcome, r.seconds, r.host, r."commit", r.dirty,
    r.finished_at FROM contradictions c JOIN results r ON r.id = c.red_result`)
    .get() as Record<string, unknown>;
  expect(audit).toMatchObject({
    project: 'flakes',
    task: 'b',
    key: proof.key,
    green_result: proof.result_id,
    kind: 'manual',
    deleted_proof: 1,
    outcome: 'manual',
    seconds: null,
    commit,
    dirty: 0,
  });
  expect(audit.recorded_at).toBe(audit.finished_at);
  expect(audit.host).toBe(Bun.spawnSync(['hostname']).stdout.toString().trim());
  expect(cli(['stats']).out.split('\n')[1]).toBe(before);
  expect(cli(['flakes']).out).toBe('no contradictions in 30d\n');
  expect(cli(['invalidate', '--task', 'b']).out).toContain('deleted 0');
  expect(db.query("SELECT * FROM results WHERE outcome = 'manual'").all()).toHaveLength(1);
  expect(cli(['run', '--tasks', 'b']).code).toBe(0);
  expect(cli(['plan']).out).toContain('PROVEN b:');
  record('b', 'red');
  expect(cli(['invalidate', '--task', 'b']).out).toContain('deleted 1');
  record('b', 'green');
  expect(cli(['plan']).out).toContain('PROVEN b:');
}, 30_000);

test('a rejected manual audit rolls back the proof deletion and result', () => {
  const { cli, db, record } = fixture();
  record('b', 'green');
  db.exec(`CREATE TRIGGER reject_manual BEFORE INSERT ON contradictions
    WHEN NEW.kind = 'manual' BEGIN SELECT RAISE(ABORT, 'manual audit rejected'); END`);
  const result = cli(['invalidate', '--task', 'b']);
  expect(result.err).toContain('manual audit rejected');
  expect(result.code).toBe(2);
  expect(db.query('SELECT * FROM proofs').all()).toHaveLength(1);
  expect(db.query("SELECT * FROM results WHERE outcome = 'manual'").all()).toHaveLength(0);
  expect(db.query('SELECT * FROM contradictions').all()).toHaveLength(0);
});

test('explicit selectors clear stale tasks and isolate keys, tasks and projects', () => {
  const { cli, db, record, repo, env } = fixture();
  record('a', 'green');
  const first = repo.git('rev-parse', 'HEAD');
  const key1 = (db.query("SELECT key FROM proofs WHERE task = 'a'").get() as { key: string }).key;
  repo.commit({ 'src/a': 'two' });
  record('a', 'green');
  record('b', 'green');
  const other = fixture('other');
  expect(other.repo.cli(['record', 'a', '--outcome', 'green'], env).code).toBe(0);
  expect(cli(['invalidate', '--task', 'a', '--key', key1]).out).toContain('deleted 1');
  expect(cli(['plan']).out).toContain('PROVEN a:');
  expect(repo.cli(['status', '--ref', first], env).out).toContain('RUN a:');
  repo.git('checkout', first);
  record('a', 'green');
  repo.git('checkout', '-');
  expect(cli(['invalidate', '--task', 'a', '--all']).out).toContain('deleted 2');
  expect(cli(['plan']).out).toContain('PROVEN b:');
  expect(other.repo.cli(['plan'], env).out).toContain('PROVEN a:');
  record('a', 'green');
  const key2 = (
    db.query("SELECT key FROM proofs WHERE project = 'flakes' AND task = 'a'").get() as {
      key: string;
    }
  ).key;
  repo.commit({
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'flakes',
      tasks: {
        b: { run: 'true', inputs: ['src/**'] },
      },
    }),
  });
  const before = db.query('SELECT * FROM contradictions').all().length;
  expect(cli(['invalidate', '--task', 'a']).err).toContain("undeclared task 'a'");
  expect(db.query('SELECT * FROM contradictions').all()).toHaveLength(before);
  expect(cli(['invalidate', '--task', 'a', '--key', key2]).out).toContain('deleted 1');
  repo.git('checkout', first);
  record('a', 'green');
  repo.git('checkout', '-');
  expect(cli(['invalidate', '--task', 'a', '--all']).out).toContain('deleted 1');
}, 30_000);

test('usage and undecidable HEAD keys fail before mutation; explicit selectors bypass inputs', () => {
  const { cli, repo, db, record } = fixture();
  record('a', 'green');
  for (const args of [
    [],
    ['--all'],
    ['--task'],
    ['--task', 'a', '--key'],
    ['--task', 'a', '--all', '--key', 'k'],
    ['--task', 'a', '--all', '--all'],
    ['--task', 'a', '--key', 'k', '--key', 'k'],
    ['--task', 'a', '--task', 'a'],
    ['--task', 'a', '--unknown'],
    ['--task', 'a', '--since', '7d'],
  ]) {
    const result = cli(['invalidate', ...args]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('usage: proof invalidate');
  }
  for (const args of [
    ['--since'],
    ['--unknown', '7d'],
    ['--since', '7d', '--since', '7d'],
    ...['0d', '-1d', '1.5d', '7', 'NaNd', '9007199254740992d', '1000000000d'].map((v) => [
      '--since',
      v,
    ]),
  ]) {
    const result = cli(['flakes', ...args]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('usage: proof flakes');
  }
  repo.commit({
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'flakes',
      tasks: {
        a: { run: 'true', inputs: ['missing/**'] },
      },
    }),
  });
  const result = cli(['invalidate', '--task', 'a']);
  expect(result.code).toBe(2);
  expect(result.err).toContain('undecidable:');
  expect(result.err).toContain('missing/**');
  expect(db.query('SELECT * FROM proofs').all()).toHaveLength(1);
  expect(db.query('SELECT * FROM contradictions').all()).toHaveLength(0);
  expect(cli(['invalidate', '--task', 'a', '--all']).out).toContain('deleted 1');
}, 30_000);

test('shared deletion locks the key, reaches clones, and fails loudly after local-only deletion', async () => {
  const postgres = await new Postgres(true).start();
  try {
    const { repo, env: local, db } = fixture();
    const clone = new Repo(repo);
    repos.push(clone);
    const env = { ...local, PROOF_STORE: postgres.url };
    const cloneEnv = { PROOF_STATE_DIR: directory(), PROOF_STORE: postgres.url };
    const cli = async (args: string[]) => output(repo.spawnCli(args, env));
    const planClone = async () => output(clone.spawnCli(['plan'], cloneEnv));
    for (const [target, settings] of [
      [repo, env],
      [clone, cloneEnv],
    ] as const)
      expect(
        (await output(target.spawnCli(['record', 'b', '--outcome', 'green'], settings))).code,
      ).toBe(0);
    const sql = postgres.connect(postgres.url);
    const [{ key }] = await sql`SELECT key FROM proofs WHERE task = 'b'`;
    const lock = JSON.stringify(['flakes', 'b', key]);
    const locker = postgres.connect(postgres.url);
    await locker`SELECT pg_advisory_lock(hashtextextended(${lock}, 0))`;
    const child = repo.spawnCli(['invalidate', '--task', 'b'], env);
    const done = output(child);
    try {
      await waitFor(
        async () =>
          (await sql`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`).length ===
          1,
      );
    } finally {
      await locker`SELECT pg_advisory_unlock(hashtextextended(${lock}, 0))`;
      expect((await done).out).toContain('deleted 1 local proof(s); deleted 1 shared proof(s)');
    }
    expect(await sql`SELECT * FROM proofs`).toHaveLength(0);
    const audit =
      await sql`SELECT c.*, r.outcome, r.seconds FROM contradictions c JOIN results r ON r.id = c.red_result`;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      kind: 'manual',
      deleted_proof: 1,
      outcome: 'manual',
      seconds: null,
    });
    expect((await cli(['flakes'])).out).toContain('no contradictions');
    expect((await planClone()).out).toContain('RUN b:');
    postgres.stop();
    expect((await planClone()).out).toContain('RUN b: contested:');
    await postgres.restart();
    expect((await cli(['run', '--tasks', 'b'])).code).toBe(0);
    expect((await cli(['plan'])).out).toContain('PROVEN b:');
    postgres.stop();
    for (const count of [1, 0]) {
      const result = await cli(['invalidate', '--task', 'b']);
      expect(result.code).toBe(2);
      expect(result.err).toContain(`deleted ${count} local proof(s); shared proof may survive`);
    }
    expect(db.query('SELECT * FROM proofs').all()).toHaveLength(0);
    const offline = await cli(['plan']);
    expect(offline.out).toContain('RUN b:');
    expect(offline.err).toContain('store unreachable');
    expect((await cli(['flakes'])).err).toContain('store unreachable');
    await postgres.restart();
    expect((await cli(['plan'])).out).toContain('PROVEN b:');
    expect(db.query('SELECT * FROM unshared_reds').all()).toHaveLength(0);
    expect((await cli(['invalidate', '--task', 'b', '--key', key])).out).toContain(
      'deleted 0 local proof(s); deleted 1 shared proof(s)',
    );
    expect(await sql`SELECT * FROM proofs`).toHaveLength(0);
    expect(
      (await output(clone.spawnCli(['record', 'b', '--outcome', 'green'], cloneEnv))).code,
    ).toBe(0);
    expect((await cli(['invalidate', '--task', 'b', '--all'])).out).toContain(
      'deleted 0 local proof(s); deleted 1 shared proof(s)',
    );
    expect(await sql`SELECT * FROM proofs`).toHaveLength(0);
    for (const outcome of ['green', 'red'])
      expect((await cli(['record', 'a', '--outcome', outcome])).code).toBe(0);
    expect((await cli(['flakes'])).out).toBe('ordinary task super\n1 a 0\n');
  } finally {
    await postgres.close();
  }
}, 60_000);

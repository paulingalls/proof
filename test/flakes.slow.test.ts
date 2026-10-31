import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

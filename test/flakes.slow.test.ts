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

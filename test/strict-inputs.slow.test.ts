import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Repo } from './support/repo';

const repos: Repo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
});
function fixture(command: (marker: string) => string, delivered: string[] = ['assets/**']) {
  const repo = new Repo();
  repos.push(repo);
  const marker = join(repo.path, '.git/attempts');
  const doc = {
    version: 1,
    project: 'strict',
    delivered,
    tasks: { read: { run: command(marker), inputs: ['source'] } },
  };
  repo.commit({
    'proof.yaml': JSON.stringify(doc),
    source: 'source',
    'assets/a': 'a',
    outside: 'outside',
  });
  const env = { PROOF_STATE_DIR: join(repo.path, '.git/state') };
  const cli = (...args: string[]) => repo.cli(args, env);
  const rows = (table = 'results') => {
    const db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
    try {
      return db.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as { outcome: string }[];
    } finally {
      db.close();
    }
  };
  return { repo, doc, marker, cli, rows };
}

test('strict first attempt receives selection without root delivery', () => {
  const f = fixture(() => 'test -f source && test ! -e assets/a');
  const result = f.cli('run', '--strict-inputs');
  expect(result.code, result.err + result.out).toBe(0);
  expect(result.out).toContain('summary: green 1, red 0');
  expect(result.out).not.toContain('declaration gap');
  expect(f.rows().map((row) => row.outcome)).toEqual(['green']);
});

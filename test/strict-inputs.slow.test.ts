import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
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

for (const fresh of [false, true]) {
  test(`strict retry records only its green outcome (${fresh ? 'fresh proven' : 'unproven'})`, () => {
    const f = fixture(
      (marker) =>
        `echo attempt >> '${marker}'; test ! -e leftover || exit 9; touch leftover; cat assets/a`,
    );
    if (fresh) expect(f.cli('run').code).toBe(0);
    const before = fresh ? f.rows().length : 0;
    const result = f.cli('run', ...(fresh ? ['--fresh'] : []), '--strict-inputs');
    expect({
      code: result.code,
      rows: f
        .rows()
        .slice(before)
        .map((row) => row.outcome),
      contradictions: f.rows('contradictions').length,
      deleted: result.out.includes('deleted proof'),
    }).toEqual({ code: 0, rows: ['green'], contradictions: 0, deleted: false });
    expect(readFileSync(f.marker, 'utf8').trim().split('\n')).toHaveLength(fresh ? 3 : 2);
    expect(result.out.match(/^(green|red) read;/gm)).toEqual(['green read;']);
    expect(result.out.match(/^progress:/gm)).toHaveLength(1);
    expect(result.out).toContain('summary: green 1, red 0');
    expect(JSON.parse(f.cli('plan', '--json').out)[0].state).toBe('PROVEN');
  });
}

test('strict retry records one final red and one fresh contradiction', () => {
  const f = fixture(
    (marker) => `echo attempt >> '${marker}'; cat assets/a; test ! -e '${marker}.fail'`,
  );
  expect(f.cli('run').code).toBe(0);
  f.repo.write('.git/attempts.fail', 'fail');
  const result = f.cli('run', '--fresh', '--strict-inputs');
  expect(result.code, result.err + result.out).toBe(1);
  expect(readFileSync(f.marker, 'utf8').trim().split('\n')).toHaveLength(3);
  expect(f.rows().map((row) => row.outcome)).toEqual(['green', 'red']);
  expect(f.rows('contradictions')).toHaveLength(1);
  expect(result.out.match(/^deleted proof local /gm)).toHaveLength(1);
  expect(result.out.match(/^red read;/gm)).toHaveLength(1);
  expect(result.out.match(/^progress:/gm)).toHaveLength(1);
  expect(result.out).toContain('summary: green 0, red 1');
});

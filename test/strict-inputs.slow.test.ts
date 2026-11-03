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
    expect(result.out.trim().split('\n').at(-1)).toBe('declaration gap read: assets/a');
    expect(JSON.parse(f.cli('plan', '--json').out)[0].state).toBe('PROVEN');
  });
}

test('strict retry records one final red and one fresh contradiction', () => {
  const f = fixture(
    (marker) =>
      `echo attempt >> '${marker}'; cat assets/a; echo "ENOENT: no such file or directory, open 'assets/a'"; test ! -e '${marker}.fail'`,
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
  expect(result.out.trim().split('\n').at(-1)).toBe('declaration gap read: assets/a');
});

test('parallel gaps follow the tally in declaration order without hint truncation', () => {
  const diagnostics = `for path in outside assets/a assets/b assets/c assets/d assets/a source untracked; do echo "ENOENT: no such file or directory, open '$path'"; done; exit 1`;
  const command = (code: number) => `if test -f assets/a; then exit ${code}; fi; ${diagnostics}`;
  const f = fixture(() => command(0));
  Object.assign(f.doc.tasks, { second: { run: command(1), inputs: ['source'] } });
  f.repo.commit({
    'proof.yaml': JSON.stringify(f.doc),
    'assets/b': 'b',
    'assets/c': 'c',
    'assets/d': 'd',
  });
  f.repo.write('untracked', 'untracked');
  const result = f.cli('run', '--strict-inputs', '--jobs', '2');
  expect(result.code, result.err + result.out).toBe(1);
  expect(result.out.trim().split('\n').slice(-3)).toEqual([
    'summary: green 1, red 1, incomplete 0, proven 0, unreached 0',
    'declaration gap read: assets/a, assets/b, assets/c, assets/d',
    'declaration gap second: assets/a, assets/b, assets/c, assets/d',
  ]);
  expect(result.out.match(/^declaration gap /gm)).toHaveLength(2);
  expect(
    f
      .rows()
      .map((row) => row.outcome)
      .sort(),
  ).toEqual(['green', 'red']);
});

for (const delivered of [true, false]) {
  test(`strict red outside delivery runs once (root delivery ${delivered})`, () => {
    const f = fixture((marker) => `echo attempt >> '${marker}'; cat outside`);
    if (!delivered)
      f.repo.commit({ 'proof.yaml': JSON.stringify({ ...f.doc, delivered: undefined }) });
    const result = f.cli('run', '--strict-inputs');
    expect(result.code, result.err + result.out).toBe(1);
    expect(readFileSync(f.marker, 'utf8')).toBe('attempt\n');
    expect(f.rows().map((row) => row.outcome)).toEqual(['red']);
    expect(result.out).toContain('not delivered: outside');
    expect(result.out).not.toContain('declaration gap');
  });
}

test('retry cannot erase first-attempt checkout changes from publication checks', () => {
  const f = fixture(
    (marker) =>
      `if test -f assets/a; then printf source > '${join(marker, '../../source')}'; else printf changed > '${join(marker, '../../source')}'; fi; cat assets/a`,
  );
  const result = f.cli('run', '--strict-inputs');
  expect(result.code, result.err + result.out).toBe(0);
  expect(result.out).toContain("green read; no proof published: selected path changed 'source'");
  expect(f.rows().map((row) => row.outcome)).toEqual(['green']);
  expect(JSON.parse(f.cli('plan', '--json').out)[0].state).toBe('RUN');
});

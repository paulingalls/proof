import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../src/declarations';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const paths: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture(tasks: Record<string, Task>, dimensions = {}) {
  const repo = Repo.from('stats', (r) => r.commit({ input: 'original', clean: 'clean' }));
  repos.push(repo);
  repo.commit({
    'proof.yaml': JSON.stringify({ version: 1, project: 'stats', tasks, dimensions }),
  });
  const state = mkdtempSync(join(tmpdir(), 'proof-stats-'));
  paths.push(state);
  const env = { PROOF_STATE_DIR: state, TZ: 'Etc/GMT-14' };
  return {
    repo,
    cli: (...args: string[]) => repo.cli(args, env),
    db: () => new Database(join(state, 'proof.db')),
  };
}
const task = (run = 'exit 0'): Task => ({ run, inputs: ['input'] });

test('only final PROVEN decisions increment one daily row; plan and fresh do not', () => {
  const { cli, db } = fixture({ a: task(), b: task('exit 7') });
  expect(cli('plan').code).toBe(0);
  using history = db();
  const skips = () =>
    history
      .query<{ project: string; task: string; day: string; count: number }, []>(
        'SELECT project, task, day, count FROM skips',
      )
      .all();
  expect(skips()).toEqual([]);
  expect(cli('record', 'a', '--outcome', 'green').code).toBe(0);
  expect(cli('run').code).toBe(1);
  const first = skips();
  expect(first).toEqual([
    {
      project: 'stats',
      task: 'a',
      day: new Date(Date.now() + 14 * 3600_000).toISOString().slice(0, 10),
      count: 1,
    },
  ]);
  expect(cli('plan').code).toBe(0);
  expect(cli('plan', '--json').code).toBe(0);
  expect(skips()).toEqual(first);
  expect(cli('run').code).toBe(1);
  expect(skips()).toEqual(first.map((row) => ({ ...row, count: 2 })));
  expect(history.query("SELECT * FROM results WHERE task = 'b'").all()).toHaveLength(2);
  expect(cli('record', 'b', '--outcome', 'green').code).toBe(0);
  expect(cli('run', '--tasks', 'a').code).toBe(0);
  expect(skips()).toEqual(first.map((row) => ({ ...row, count: 3 })));
  expect(cli('run', '--fresh', '--tasks', 'a').code).toBe(0);
  expect(skips()).toEqual(first.map((row) => ({ ...row, count: 3 })));
});

test('all-time green medians price actual skips and expose unpriced tasks', () => {
  const { cli } = fixture({ a: task(), b: task(), c: task(), d: task() });
  for (const [id, outcome, seconds] of [
    ['a', 'green', '10'],
    ['a', 'green', '20'],
    ['a', 'green', '90'],
    ['a', 'red', '600'],
    ['a', 'green', undefined],
    ['b', 'green', '10'],
    ['b', 'green', '30'],
    ['c', 'green', undefined],
  ] as const) {
    expect(
      cli('record', id, '--outcome', outcome, ...(seconds ? ['--seconds', seconds] : [])).code,
    ).toBe(0);
  }
  for (let i = 0; i < 3; i++) expect(cli('run', '--tasks', 'a', 'c').code).toBe(0);
  const result = cli('stats');
  expect(result.code).toBe(0);
  expect(result.out).toBe(
    'a: median 20s; 5 runs in 30d\nb: median 20s; 2 runs in 30d\n' +
      'c: median unavailable; 1 runs in 30d\nd: median unavailable; 0 runs in 30d\n' +
      'estimated 0m for 1 RUN tasks; unpriced 1: d\n' +
      'saved 1m of 13.67m in 30d (7.32%); previous 30d: unavailable; unpriced skips: 3 current, 0 previous\n',
  );
});

test('calendar windows, roster scope and current RUN estimate use exactly the selected history', () => {
  const { repo, cli, db } = fixture({
    a: { ...task(), sets: ['push'] },
    b: { ...task(), sets: ['push'] },
    c: { ...task(), sets: ['push'] },
    proven: { run: 'exit 0', inputs: ['clean'], sets: ['push'] },
    excluded: { ...task(), sets: ['other'] },
  });
  expect(cli('record', 'proven', '--outcome', 'green', '--seconds', '30').code).toBe(0);
  using history = db();
  history.exec("UPDATE results SET finished_at = '2000-01-01T00:00:00.000Z'");
  const now = new Date(Date.now() + 14 * 3600_000);
  const boundary = (offset: number) =>
    new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset) - 14 * 3600_000,
    );
  const day = (offset: number) =>
    new Date(+boundary(offset) + 14 * 3600_000).toISOString().slice(0, 10);
  const result = (
    id: string,
    outcome: string,
    seconds: number | null,
    at: Date,
    project = 'stats',
  ) =>
    history
      .query(
        'INSERT INTO results (project, task, key, outcome, seconds, host, "commit", dirty, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(project, id, 'history', outcome, seconds, 'host', 'commit', 1, at.toISOString());
  const skip = (id: string, offset: number, count: number, project = 'stats') =>
    history.query('INSERT INTO skips VALUES (?, ?, ?, ?)').run(project, id, day(offset), count);
  for (const seconds of [10, 20, 90]) result('a', 'green', seconds, boundary(-10));
  result('b', 'green', 40, boundary(-10));
  result('a', 'red', 60, boundary(-1));
  result('a', 'incomplete', 360, boundary(-3));
  result('a', 'green', null, boundary(0));
  result('a', 'red', 9999, boundary(1));
  result('a', 'red', 9999, new Date(+boundary(-3) - 1));
  result('a', 'red', 9999, boundary(0), 'another-project');
  result('excluded', 'green', 9999, boundary(0));
  skip('a', -1, 3);
  skip('a', -3, 6);
  skip('a', 1, 9999);
  skip('a', -4, 9999);
  skip('a', 0, 9999, 'another-project');
  skip('excluded', 0, 9999);
  repo.write('input', 'dirty');
  const stats = (...args: string[]) =>
    repo.cli(['stats', ...args], {
      PROOF_STATE_DIR: history.filename.replace(/\/proof.db$/, ''),
      TZ: 'Etc/GMT-14',
    });
  const expected =
    'a: median 20s; 2 runs in 2d\nb: median 40s; 0 runs in 2d\nc: median unavailable; 0 runs in 2d\nproven: median 30s; 0 runs in 2d\nestimated 1m for 3 RUN tasks; unpriced 1: c\nsaved 1m of 2m in 2d (50%); previous 2d: 25%\n';
  expect(stats('--since', '2d', '--set', 'push')).toEqual({ code: 0, out: expected, err: '' });
  expect(stats('--set', 'push', '--since', '2d').out).toBe(expected);
  expect(stats('--since', '2d').out).toContain('excluded: median 9999s; 1 runs in 2d');
  skip('c', 0, 2);
  skip('c', -2, 4);
  expect(stats('--since', '2d', '--set', 'push').out.trim().split('\n').at(-1)).toBe(
    'saved 1m of 2m in 2d (50%); previous 2d: 25%; unpriced skips: 2 current, 4 previous',
  );
  history.exec("DELETE FROM skips; DELETE FROM results WHERE task != 'proven'");
  expect(stats('--since', '2d').out.trim().split('\n').at(-1)).toBe(
    'saved 0m of 0m in 2d (unavailable); previous 2d: unavailable',
  );
  result('a', 'green', 0, boundary(0));
  skip('a', 0, 2);
  expect(stats('--since', '2d').out.trim().split('\n').at(-1)).toBe(
    'saved 0m of 0m in 2d (unavailable); previous 2d: unavailable',
  );
  result('a', 'red', 60, boundary(-3));
  expect(stats('--since', '2d').out.trim().split('\n').at(-1)).toBe(
    'saved 0m of 0m in 2d (unavailable); previous 2d: 0%',
  );
});

test('invalid stats arguments fail with usage; unknown set shares plan diagnostics', () => {
  const { cli } = fixture({ a: { ...task(), sets: ['push'] } });
  for (const args of [
    ['--since', '0d'],
    ['--since', 'x'],
    ['--unknown'],
    ['--by'],
    ['--by', 'missing'],
    ['--where', 'x'],
    ['--by', 'platform', '--by', 'platform'],
    ['--json', '--json'],
    ['--since'],
    ['--set'],
    ['--since', '1d', '--since', '2d'],
    ['--set', 'push', '--set', 'push'],
    ['--since', '999999999999999999d'],
    ['--since', '99999999999d'],
  ]) {
    const result = cli('stats', ...args);
    expect(result.code).toBe(2);
    expect(result.err).toBe(
      'proof: usage: proof stats [--set <name>] [--since Nd] [--by <dimension>] [--json]\n',
    );
    expect(result.out).toBe('');
  }
  expect(cli('stats', '--set', 'missing')).toEqual(cli('plan', '--set', 'missing'));
});

test('every recorded outcome retains resolved dimensions', () => {
  const { cli, db } = fixture(
    { a: { ...task('exit 7'), dimensions: ['platform', 'arch'] } as unknown as Task, b: task() },
    { platform: 'printf ios', arch: 'printf arm64' },
  );
  for (const outcome of ['green', 'red', 'incomplete'])
    expect(cli('record', 'a', '--outcome', outcome).code).toBe(0);
  expect(cli('run', '--fresh', '--tasks', 'a').code).toBe(1);
  expect(cli('record', 'b', '--outcome', 'green').code).toBe(0);
  using history = db();
  expect(
    history
      .query(`SELECT r.outcome, d.name, d.value FROM results r
    JOIN dimension_values d ON d.result_id = r.id ORDER BY r.id, d.name`)
      .all(),
  ).toEqual(
    ['green', 'red', 'incomplete', 'red'].flatMap((outcome) => [
      { outcome, name: 'arch', value: 'arm64' },
      { outcome, name: 'platform', value: 'ios' },
    ]),
  );
});

test('dimension splits reconcile window runs and JSON shares text figures', () => {
  const { cli, db } = fixture(
    {
      a: { ...task(), dimensions: ['platform'], sets: ['push'] } as unknown as Task,
      b: { ...task(), sets: ['push'] },
      excluded: task(),
    },
    { platform: 'printf ios', arch: 'printf arm64' },
  );
  expect(cli('plan').code).toBe(0);
  using history = db();
  const samples = [
    ['ios', 'green', 10],
    ['ios', 'green', 30],
    ['ios', 'red', 600],
    ['ios', 'green', null],
    ['ios', 'incomplete', null],
    ['android', 'green', 50],
    ['android', 'red', 900],
    [null, 'green', 70],
    [null, 'red', 800],
    ['red-only', 'red', 0],
  ] as const;
  for (const [value, outcome, seconds] of [...samples, ['ios', 'green', 100] as const]) {
    const at = seconds === 100 ? '2000-01-01T00:00:00.000Z' : new Date().toISOString();
    const inserted = history
      .query(`INSERT INTO results
      (project, task, key, outcome, seconds, host, "commit", dirty, finished_at)
      VALUES ('stats', 'a', 'seed', ?, ?, 'host', 'commit', 1, ?)`)
      .run(outcome, seconds, at);
    if (value !== null) {
      history
        .query('INSERT INTO dimension_values VALUES (?, ?, ?)')
        .run(inserted.lastInsertRowid, 'platform', value);
      history
        .query('INSERT INTO dimension_values VALUES (?, ?, ?)')
        .run(inserted.lastInsertRowid, 'arch', 'arm64');
    }
  }
  const split = {
    dimension: 'platform',
    values: [
      { value: 'android', median: 50, runs: 2 },
      { value: 'ios', median: 20, runs: 5 },
      { value: 'red-only', median: null, runs: 1 },
      { value: null, median: 70, runs: 2 },
    ],
  };
  const text = cli('stats', '--since', '2d', '--by', 'platform', '--set', 'push');
  expect(text.code).toBe(0);
  expect(text.out).toBe(
    'a: median 50s; 10 runs in 2d\n' +
      '  platform="android": median 50s; 2 runs in 2d\n' +
      '  platform="ios": median 20s; 5 runs in 2d\n' +
      '  platform="red-only": median unavailable; 1 runs in 2d\n' +
      '  platform=(no recorded value): median 70s; 2 runs in 2d\n' +
      'b: median unavailable; 0 runs in 2d\nestimated 0.83m for 2 RUN tasks; unpriced 1: b\n' +
      'saved 0m of 41m in 2d (0%); previous 2d: unavailable\n',
  );
  for (const by of [[], ['--by', 'platform']])
    for (const set of [[], ['--set', 'push']]) {
      const result = cli('stats', '--json', ...by, '--since', '2d', ...set);
      expect(result.code).toBe(0);
      const report = JSON.parse(result.out);
      expect(report).toEqual({
        days: 2,
        tasks: [
          { task: 'a', median: 50, runs: 10, ...(by.length ? { split } : {}) },
          { task: 'b', median: null, runs: 0 },
          ...(set.length ? [] : [{ task: 'excluded', median: null, runs: 0 }]),
        ],
        estimate: {
          seconds: 50,
          runs: set.length ? 2 : 3,
          unpriced: set.length ? ['b'] : ['b', 'excluded'],
        },
        saved: {
          current: { seconds: 0, totalSeconds: 2460, percent: 0, unpricedSkips: 0 },
          previous: { seconds: 0, totalSeconds: 0, percent: null, unpricedSkips: 0 },
        },
      });
    }
  expect(cli('stats', '--by', 'arch').code).toBe(2);
});

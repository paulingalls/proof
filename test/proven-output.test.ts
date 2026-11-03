import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../src/declarations';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(tasks: Record<string, Task>) {
  const repo = Repo.from('proven-output', (r) => r.commit({ 'src/a.ts': 'original' }));
  repos.push(repo);
  repo.commit({ 'proof.yaml': JSON.stringify({ version: 1, project: 'output', tasks }) });
  const dir = mkdtempSync(join(tmpdir(), 'proof-output-'));
  dirs.push(dir);
  const env = { PROOF_STATE_DIR: join(dir, 'state'), TMPDIR: dir };
  const cli = (...args: string[]) => repo.cli(args, env);
  const record = (id: string) => expect(cli('record', id, '--outcome', 'green').code).toBe(0);
  const plan = () => {
    const result = cli('plan', '--json');
    expect(result.code).toBe(0);
    return (JSON.parse(result.out) as { state: string; task: string; reason: string }[]).map(
      (row) => `${row.state} ${row.task}: ${row.reason}`,
    );
  };
  return { repo, env, cli, record, plan };
}

for (const jobs of ['1', '2']) {
  test(`all-proven output prints each task once with jobs ${jobs}, retaining skip counts`, () => {
    const s = fixture({
      a: { run: 'exit 99', inputs: ['src/a.ts'] },
      b: { run: 'exit 99', inputs: ['src/a.ts'] },
    });
    s.record('a');
    s.record('b');
    const plan = s.plan();
    expect(plan.every((line) => line.startsWith('PROVEN '))).toBe(true);
    using db = new Database(join(s.env.PROOF_STATE_DIR, 'proof.db'));
    const results = db.query('SELECT * FROM results ORDER BY rowid').all();
    for (const count of [1, 2]) {
      const result = s.cli('run', '--jobs', jobs);
      expect(result.code).toBe(0);
      expect(result.err).toBe('');
      expect(result.out).toBe(
        [
          `run: 2 tasks, jobs ${jobs}`,
          ...plan,
          'summary: green 0, red 0, incomplete 0, proven 2, unreached 0',
          '',
        ].join('\n'),
      );
      expect(db.query('SELECT * FROM results ORDER BY rowid').all()).toEqual(results);
      expect(db.query('SELECT task, count FROM skips ORDER BY task').all()).toEqual([
        { task: 'a', count },
        { task: 'b', count },
      ]);
    }
  });

  test(`executed task keeps its output and counts quiet PROVEN with jobs ${jobs}`, () => {
    const s = fixture({
      cached: { run: 'exit 99', inputs: ['src/a.ts'], lane: 'solo' },
      executed: { run: 'true', inputs: ['src/a.ts'] },
    });
    s.record('cached');
    const plan = s.plan();
    const result = s.cli('run', '--jobs', jobs);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toBe(
      [
        `run: 2 tasks, jobs ${jobs}`,
        ...plan,
        ...(jobs === '2' ? ['--- executed', ''] : []),
        'progress: 2/2 done; green 1, red 0, incomplete 0, proven 1, unreached 0; task executed',
        'green executed; proof published',
        'summary: green 1, red 0, incomplete 0, proven 1, unreached 0',
        '',
      ].join('\n'),
    );
  });
}

test('a decision revised from RUN to PROVEN retains progress and final output', () => {
  const s = fixture({});
  s.repo.commit({
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'output',
      tasks: {
        first: { run: `printf original > '${s.repo.path}/src/a.ts'`, inputs: ['clean'] },
        later: { run: 'exit 99', inputs: ['src/a.ts'] },
      },
    }),
    clean: 'clean',
  });
  s.record('later');
  const proven = s.plan()[1] as string;
  s.repo.write('src/a.ts', 'dirty');
  const result = s.cli('run', '--jobs', '1');
  expect(result.code).toBe(0);
  expect(result.err).toBe('');
  const lines = result.out.trimEnd().split('\n');
  const preview = "RUN later: undecidable: dirty input 'src/a.ts'";
  expect(lines).toContain(preview);
  expect(lines.filter((line) => line === proven)).toHaveLength(2);
  expect(lines.indexOf(preview)).toBeLessThan(lines.indexOf(proven));
  const progress =
    'progress: 2/2 done; green 1, red 0, incomplete 0, proven 1, unreached 0; task later';
  expect(lines.indexOf(proven)).toBeLessThan(lines.indexOf(progress));
  expect(lines.indexOf(progress)).toBeLessThan(lines.lastIndexOf(proven));
});

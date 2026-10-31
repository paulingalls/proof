import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

let repo: Repo;
let state: string;
afterEach(() => {
  repo?.close();
  if (state) rmSync(state, { recursive: true, force: true });
});
function fixture() {
  repo = new Repo();
  state = mkdtempSync(join(tmpdir(), 'proof-sets-'));
  return (id: string, sets?: unknown) => ({
    run: `test -f input && echo ${id} >> '${state}/log'`,
    inputs: ['input'],
    ...(sets === undefined ? {} : { sets }),
  });
}
const cli = (...args: string[]) => repo.cli(args, { PROOF_STATE_DIR: join(state, 'store') });
const log = () => (existsSync(join(state, 'log')) ? readFileSync(join(state, 'log'), 'utf8') : '');
const rows = (...args: string[]) => {
  const result = cli(...args, '--json');
  expect(result.code).toBe(args[0] === 'status' && result.out.includes('"RUN"') ? 1 : 0);
  return JSON.parse(result.out).map((r: { task: string; state: string }) => [r.task, r.state]);
};
const root = (tasks: unknown) =>
  JSON.stringify({ version: 1, project: 'sets', include: 'proof.d/*.yaml', tasks });

test('run boundaries, overlap, unassigned, fresh and argument validation', () => {
  const task = fixture();
  repo.commit({
    'proof.yaml': root({
      a: task('a', ['commit', 'commit']),
      b: task('b', ['push']),
      d: task('d', []),
    }),
    'proof.d/tasks.yaml': JSON.stringify({ tasks: { c: task('c', ['commit', 'push']) } }),
    input: 'ok',
  });
  expect(cli('run', '--set', 'commit').code).toBe(0);
  expect(log()).toBe('a\nc\n');
  expect(cli('run', '--set', 'commit').out).toContain('PROVEN a');
  expect(log()).toBe('a\nc\n');
  rmSync(join(state, 'store'), { recursive: true });
  expect(cli('run', '--set', 'push').code).toBe(0);
  expect(log()).toBe('a\nc\nb\nc\n');
  expect(rows('plan').map(([id]: string[]) => id)).toEqual(['a', 'b', 'd', 'c']);
  rmSync(join(state, 'store'), { recursive: true });
  expect(cli('run').code).toBe(0);
  expect(log()).toBe('a\nc\nb\nc\na\nb\nd\nc\n');
  const fresh = cli('run', '--fresh', '--set', 'commit');
  expect(fresh.code).toBe(0);
  expect(fresh.out).toContain('fresh execution requested');
  expect(fresh.out).toContain('proof published');
  const before = log();
  expect(before).toBe('a\nc\nb\nc\na\nb\nd\nc\na\nc\n');
  expect(rows('plan').every(([, s]: string[]) => s === 'PROVEN')).toBe(true);
  for (const args of [
    ['--set', 'commit', '--tasks', 'a'],
    ['--tasks', 'a', '--set', 'commit'],
    ['--set'],
    ['--set', 'commit', '--set', 'push'],
  ])
    expect(cli('run', ...args)).toEqual({
      code: 2,
      out: '',
      err: 'proof: usage: proof run [--fresh] [--tasks <id> ... | --set <name>]\n',
    });
  expect(log()).toBe(before);
}, 30_000);

test('membership requires a list of nonempty strings', () => {
  const task = fixture();
  for (const [sets, message] of [
    ['commit', 'sets must be a list'],
    [[1], 'set name: expected a nonempty string'],
    [[' '], 'set name: expected a nonempty string'],
  ]) {
    repo.commit({
      'proof.yaml': JSON.stringify({
        version: 1,
        project: 'sets',
        tasks: { bad: task('bad', sets) },
      }),
      input: 'ok',
    });
    const result = cli('run');
    expect(result.code).toBe(2);
    expect(result.err).toContain(
      `task 'bad'${String(message).startsWith('sets') ? ':' : ''} ${message}`,
    );
  }
});

test('plan and status select their declaration view without changing proof identity', () => {
  const task = fixture();
  const declaration = (set: string) => JSON.stringify({ tasks: { earned: task('earned', [set]) } });
  const a = repo.commit({
    'proof.yaml': root({ pending: task('pending', ['push']) }),
    'proof.d/tasks.yaml': declaration('commit'),
    input: 'ok',
  });
  expect(rows('plan', '--set', 'push')).toEqual([['pending', 'RUN']]);
  expect(rows('status', '--set', 'push', '--ref', 'HEAD')).toEqual([['pending', 'RUN']]);
  expect(cli('run', '--set', 'commit').code).toBe(0);
  const before = log();
  repo.commit({
    'proof.yaml': root({ pending: task('pending', ['commit']) }),
    'proof.d/tasks.yaml': declaration('push'),
  });
  expect(rows('plan', '--set', 'push')).toEqual([['earned', 'PROVEN']]);
  expect(cli('run', '--set', 'push').out).toContain('PROVEN earned');
  expect(log()).toBe(before);
  expect(rows('plan', '--set', 'commit')).toEqual([['pending', 'RUN']]);
  expect(rows('status', '--ref', a, '--set', 'commit')).toEqual([['earned', 'PROVEN']]);
  expect(rows('status', '--ref', a, '--set', 'push')).toEqual([['pending', 'RUN']]);
  expect(rows('status', '--ref', 'HEAD', '--set', 'push')).toEqual([['earned', 'PROVEN']]);
  repo.write('proof.d/tasks.yaml', declaration('working'));
  const dirty = cli('run', '--set', 'working');
  expect(dirty.code).toBe(0);
  expect(dirty.out).toContain('not recorded: dirty declaration');
  expect(log()).toBe(`${before}earned\n`);
  expect(rows('status', '--ref', 'HEAD', '--set', 'push')).toEqual([['earned', 'PROVEN']]);
  for (const command of ['plan', 'status']) {
    const prefix = command === 'status' ? ['--ref', 'HEAD'] : [];
    for (const args of [['--set'], ['--set', 'push', '--set', 'commit']])
      expect(cli(command, ...prefix, ...args)).toEqual({
        code: 2,
        out: '',
        err: `proof: usage: proof ${command} ${command === 'status' ? '--ref <ref> ' : ''}[--set <name>] [--json]\n`,
      });
  }
}, 30_000);

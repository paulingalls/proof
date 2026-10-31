import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

test('task set boundaries, proof reuse, historical views and invalid selectors', () => {
  const repo = new Repo();
  const state = mkdtempSync(join(tmpdir(), 'proof-sets-'));
  const env = { PROOF_STATE_DIR: join(state, 'store') };
  const task = (id: string, sets?: unknown) => ({
    run: `test -f input && echo ${id} >> '${state}/log'`,
    inputs: ['input'],
    sets,
  });
  const base = { version: 1, project: 'sets', include: 'proof.d/*.yaml' };
  const declare = (tasks: unknown, included = {}) =>
    repo.commit({
      'proof.yaml': JSON.stringify({ ...base, tasks }),
      'proof.d/tasks.yaml': JSON.stringify({ tasks: included }),
      input: 'ok',
    });
  const log = () =>
    existsSync(join(state, 'log')) ? readFileSync(join(state, 'log'), 'utf8') : '';
  const cli = (command: string, code = 0) => {
    const result = repo.cli(command.split(' '), env);
    expect(result.code).toBe(code);
    return result;
  };
  const rejected = (command: string, message: string) =>
    expect(cli(command, 2)).toEqual({ code: 2, out: '', err: `proof: ${message}\n` });
  const rows = (command: string, expected: string) => {
    const result = cli(
      command.includes('--json') ? command : `${command} --json`,
      command.startsWith('status') && expected.includes('RUN') ? 1 : 0,
    );
    const decisions: { task: string; state: string }[] = JSON.parse(result.out);
    expect(decisions.map((r) => `${r.task}:${r.state}`).join(' ')).toBe(expected);
  };
  try {
    declare(
      { a: task('a', ['commit', 'commit']), b: task('b', ['push']), d: task('d', []) },
      { c: task('c', ['commit', 'push']) },
    );
    for (const [command, store, delta, message] of [
      ['run --set commit', 'cold', 'a\nc\n', 'RUN a'],
      ['run --set commit', 'cold', '', 'PROVEN a'],
      ['run --set push', 'other', 'b\nc\n', 'RUN b'],
      ['run', 'all', 'a\nb\nd\nc\n', 'RUN d'],
      ['run --fresh --set commit', 'all', 'a\nc\n', 'fresh execution requested'],
    ] as const) {
      env.PROOF_STATE_DIR = join(state, store);
      const before = log();
      const result = cli(command);
      expect(result.out).toContain(message);
      if (command.includes('--fresh')) expect(result.out).toContain('proof published');
      expect(log()).toBe(before + delta);
    }
    const before = log();
    rows('plan', 'a:PROVEN b:PROVEN d:PROVEN c:PROVEN');
    for (const args of [
      '--set commit --tasks a',
      '--tasks a --set commit',
      '--set',
      '--set commit --set push',
    ])
      rejected(`run ${args}`, 'usage: proof run [--fresh] [--tasks <id> ... | --set <name>]');
    expect(log()).toBe(before);
    const a = declare(
      { pending: task('pending', ['push']) },
      { earned: task('earned', ['commit']) },
    );
    rows('plan --json --set push', 'pending:RUN');
    rows('status --set push --ref HEAD', 'pending:RUN');
    cli('run --set commit');
    const earned = log();
    declare({ pending: task('pending', ['commit']) }, { earned: task('earned', ['push']) });
    rows('plan --set push', 'earned:PROVEN');
    expect(cli('run --set push').out).toContain('PROVEN earned');
    expect(log()).toBe(earned);
    for (const [command, expected] of [
      ['plan --set commit', 'pending:RUN'],
      [`status --ref ${a} --set commit`, 'earned:PROVEN'],
      [`status --ref ${a} --set push`, 'pending:RUN'],
      ['status --ref HEAD --set push', 'earned:PROVEN'],
    ] as const)
      rows(command, expected);
    repo.write(
      'proof.d/tasks.yaml',
      JSON.stringify({ tasks: { earned: task('earned', ['working']) } }),
    );
    expect(cli('run --set working').out).toContain('not recorded: dirty declaration');
    expect(log()).toBe(`${earned}earned\n`);
    rows('status --ref HEAD --set push', 'earned:PROVEN');
    for (const command of ['plan', 'status --ref HEAD']) {
      for (const args of ['--set', '--set push --set commit'])
        rejected(
          `${command} ${args}`,
          `usage: proof ${command.replace('HEAD', '<ref>')} [--set <name>] [--json]`,
        );
    }
    repo.git('checkout', '--', 'proof.d/tasks.yaml');
    for (const command of ['plan', 'run', 'status --ref HEAD'])
      rejected(`${command} --set missing`, "unknown task set 'missing'; known sets: commit, push");
    expect(log()).toBe(`${earned}earned\n`);
    declare({ unassigned: task('unassigned') });
    rejected('run --set missing', "unknown task set 'missing'; known sets: none");
    for (const [sets, message] of [
      ['commit', ': sets must be a list'],
      [[1], ' set name: expected a nonempty string'],
      [[' '], ' set name: expected a nonempty string'],
    ]) {
      declare({ bad: task('bad', sets) });
      rejected('run', `ref 'HEAD' proof.yaml task 'bad'${message}`);
    }
  } finally {
    repo.close();
    rmSync(state, { recursive: true, force: true });
  }
}, 30_000);

import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { alive, fixture, killGroup, spawn, stop, task, until, wait } from './support/jobs';

test('budgets kill entire groups as red without cancelling other tasks', async () => {
  const f = fixture({
    over: {
      ...task(
        `echo $$ > scratch/leader; trap '' TERM; sh -c 'trap "" TERM; touch scratch/ready; while :; do sleep 1; done' & echo $! > scratch/child; wait`,
      ),
      timeout: 1,
    },
    untimed: task(wait('release')),
    within: { ...task('true'), timeout: 2147483 },
    failing: { ...task('false'), timeout: 2147483 },
  });
  const { child, output } = spawn(f, '--jobs', '2');
  try {
    await until(() => f.has('ready') && f.has('child'));
    await until(() => !alive(Number(f.read('leader'))) && !alive(Number(f.read('child'))));
    f.mark('release');
    await until(() => child.exitCode !== null);
    expect(await child.exited).toBe(1);
    const [out, err] = await output;
    expect(err).toBe('');
    expect(out.match(/killed at budget/g)).toHaveLength(1);
    expect(out).toMatch(/red over; killed at budget after 1 seconds; log: /);
    expect(out).toMatch(
      /^progress: [12]\/4 done; green [01], red 1, incomplete 0, proven 0, unreached 0; task over$/m,
    );
    expect(out).toContain('progress: 4/4 done;');
    expect(out).toEndWith('summary: green 2, red 2, incomplete 0, proven 0, unreached 0\n');
    expect(f.rows().sort((a, b) => a.task.localeCompare(b.task))).toMatchObject([
      { task: 'failing', outcome: 'red' },
      { task: 'over', outcome: 'red' },
      { task: 'untimed', outcome: 'green' },
      { task: 'within', outcome: 'green' },
    ]);
    expect(
      (f.rows().find((r) => r.task === 'over') as unknown as { seconds: number }).seconds,
    ).toBeGreaterThanOrEqual(1);
    expect(readdirSync(f.env.TMPDIR)).toEqual([]);
  } finally {
    if (f.has('leader')) killGroup(Number(f.read('leader')));
    await stop(child).finally(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
  }
});

test('interrupt lets a handler finish beyond its budget and records incomplete', async () => {
  const f = fixture({
    active: {
      ...task(
        `echo $$ > scratch/leader; trap 'touch scratch/received; ${wait('release')}; touch scratch/finished; exit 0' INT; touch scratch/ready; while :; do sleep 0.01; done`,
      ),
      timeout: 1,
    },
    queued: task('touch scratch/queued'),
  });
  const { child, output } = spawn(f);
  try {
    await until(() => f.has('ready'));
    child.kill('SIGINT');
    await until(() => f.has('received'));
    await Bun.sleep(1200);
    f.mark('release');
    await until(() => child.exitCode !== null);
    expect(await child.exited).toBe(130);
    expect(f.has('finished')).toBe(true);
    expect(f.has('queued')).toBe(false);
    expect(f.rows()).toMatchObject([{ task: 'active', outcome: 'incomplete' }]);
    expect((await output).join('')).not.toContain('killed at budget');
    expect(readdirSync(f.env.TMPDIR)).toEqual([]);
  } finally {
    if (f.has('leader')) killGroup(Number(f.read('leader')));
    await stop(child).finally(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
  }
});

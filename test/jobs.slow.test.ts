import { expect, test } from 'bun:test';
import { fixture, spawn, stop, task, until, wait } from './support/jobs';

test('default and explicit jobs=1 preserve the serial transcript', () => {
  const f = fixture({
    a: task('echo a-out; echo a-err >&2; exit 1'),
    b: task('echo b-out; echo b-err >&2'),
  });
  const expected = {
    code: 1,
    out: 'RUN a: no proof for key; trusted links: scratch\nRUN b: no proof for key; trusted links: scratch\na-out\nb-out\nred a\ngreen b; proof published\n',
    err: 'a-err\nb-err\n',
  };
  const first = f.run();
  expect(first).toEqual(expected);
  expect(f.repo.cli(['run', '--jobs', '1'], { ...f.env, PROOF_STATE_DIR: f.directory() })).toEqual(
    expected,
  );
}, 15000);

test('jobs requires one positive safe integer before the selector', () => {
  const f = fixture({ a: task('true') });
  for (const args of [
    ['--jobs', '0'],
    ['--jobs', 'x'],
    ['--jobs'],
    ['--jobs', '-1'],
    ['--jobs', '1.5'],
    ['--jobs', '9007199254740992'],
    ['--jobs', '1', '--jobs', '2'],
    ['--tasks', 'a', '--jobs', '2'],
  ]) {
    const result = f.run(...args);
    expect(result.code).toBe(2);
    expect(result.err).toContain(
      'usage: proof run [--fresh | --staged] [--jobs N] [--tasks <id> ... | --set <name>]',
    );
  }
  expect(f.run('--jobs', '2').code).toBe(0);
}, 15000);

test('two mutual-marker tasks need two jobs, without timing assertions', () => {
  for (const jobs of ['1', '2']) {
    const f = fixture(
      Object.fromEntries(
        ['a', 'b'].map((id) => [
          id,
          {
            ...task(`'${process.execPath}' barrier.ts ${id}`),
            inputs: ['input', 'barrier.ts'],
          },
        ]),
      ),
      {},
      {
        'barrier.ts': `import { existsSync, writeFileSync } from 'node:fs';
const id = process.argv[2];
writeFileSync('scratch/' + id, 'yes');
const deadline = Date.now() + 1500;
while (!existsSync('scratch/' + (id === 'a' ? 'b' : 'a'))) {
  if (Date.now() > deadline) { writeFileSync('scratch/failed', 'yes'); break; }
  await Bun.sleep(10);
}
process.exit(existsSync('scratch/failed') ? 1 : 0);`,
      },
    );
    const result = f.run('--jobs', jobs);
    expect(result.code, result.err + result.out).toBe(jobs === '2' ? 0 : 1);
    expect(f.rows().map((row) => row.outcome)).toEqual(
      jobs === '2' ? ['green', 'green'] : ['red', 'red'],
    );
  }
}, 15000);

test('dispatch is bounded and a free slot starts the next declared task', async () => {
  const f = fixture(
    Object.fromEntries(
      ['a', 'b', 'c'].map((id) => [id, task(`touch scratch/${id}; ${wait(`release-${id}`)}`)]),
    ),
  );
  const { child, output } = spawn(f, '--jobs', '2');
  try {
    await until(() => f.has('a') && f.has('b'));
    expect(f.has('c')).toBe(false);
    f.mark('release-a');
    await until(() => f.has('c'));
    expect(f.has('release-b')).toBe(false);
    f.mark('release-b');
    f.mark('release-c');
    expect(await child.exited).toBe(0);
    expect((await output)[1]).toBe('');
  } finally {
    for (const id of ['a', 'b', 'c']) f.mark(`release-${id}`);
    await stop(child);
  }
}, 15000);

test('one awaited provider stays ready for running and pending dependents', async () => {
  const f = fixture(
    {
      a: task(`test -f scratch/ready; touch scratch/a; ${wait('b')}; touch scratch/end-a`, [
        'stack',
      ]),
      b: task(`test -f scratch/ready; touch scratch/b; ${wait('a')}; touch scratch/end-b`, [
        'stack',
      ]),
      c: task('test -f scratch/ready; touch scratch/end-c', ['stack']),
    },
    {
      stack: {
        start: `echo start >> scratch/log; ${wait('release')}; touch scratch/ready`,
        stop: 'test -f scratch/end-a && test -f scratch/end-b && test -f scratch/end-c && echo stop >> scratch/log',
      },
    },
  );
  const { child, output } = spawn(f, '--jobs', '2');
  try {
    await until(() => f.has('log'));
    expect(f.has('a') || f.has('b')).toBe(false);
    f.mark('release');
    await until(() => child.exitCode !== null);
    const [out, err] = await output;
    expect(await child.exited, err + out).toBe(0);
    expect(f.read('log')).toBe('start\nstop\n');
    expect(f.rows().map((r) => r.outcome)).toEqual(['green', 'green', 'green']);
  } finally {
    f.mark('release');
    await stop(child);
  }
}, 15000);

test('failed shared startup records three incomplete dependents and lets unrelated work finish', async () => {
  const f = fixture(
    {
      a: task('touch scratch/should-not-run', ['stack']),
      b: task('touch scratch/should-not-run', ['stack']),
      c: task('touch scratch/should-not-run', ['stack']),
      other: task(`touch scratch/other; ${wait('failed')}; touch scratch/other-ended`),
    },
    {
      stack: {
        start: `echo start >> scratch/log; ${wait('release')}; touch scratch/failed; exit 1`,
        stop: 'echo stop >> scratch/log',
      },
    },
  );
  for (const id of ['a', 'b', 'c'])
    for (const outcome of ['green', 'red'])
      expect(f.repo.cli(['record', id, '--outcome', outcome], f.env).code).toBe(0);
  const proofs = f.rows('proofs');
  const contests = f.rows('contradictions');
  const { child, output } = spawn(f, '--jobs', '4');
  try {
    await until(() => f.has('other') && f.has('log'));
    f.mark('release');
    await until(() => child.exitCode !== null);
    const [out, err] = await output;
    expect(await child.exited, err + out).toBe(1);
    expect(err).toBe('');
    expect(
      f
        .rows()
        .slice(6)
        .sort((a, b) => a.task.localeCompare(b.task)),
    ).toMatchObject([
      { task: 'a', outcome: 'incomplete' },
      { task: 'b', outcome: 'incomplete' },
      { task: 'c', outcome: 'incomplete' },
      { task: 'other', outcome: 'green' },
    ]);
    expect(f.rows('proofs').filter((r) => r.task !== 'other')).toEqual(proofs);
    expect(f.rows('contradictions')).toEqual(contests);
    expect(f.has('should-not-run')).toBe(false);
    expect(f.read('log')).toBe('start\nstop\n');
  } finally {
    f.mark('release');
    f.mark('failed');
    await stop(child);
  }
}, 15000);

test('eight simultaneous greens retain every result and matching proof locally', () => {
  const ids = Array.from({ length: 8 }, (_, index) => `task${index}`);
  const f = fixture(
    Object.fromEntries(
      ids.map((id) => [
        id,
        task(
          `touch scratch/${id}; while test "$(find scratch/ -name 'task*' | wc -l)" -lt 8; do sleep 0.01; done`,
        ),
      ]),
    ),
  );
  const result = f.run('--jobs', '8');
  expect(result.code, result.err + result.out).toBe(0);
  expect(result.err).toBe('');
  const results = f.rows();
  const proofs = f.rows('proofs');
  expect(results).toHaveLength(8);
  expect(proofs).toHaveLength(8);
  for (const row of results) {
    expect(row.outcome).toBe('green');
    expect(proofs.find((p) => p.task === row.task)).toMatchObject({
      key: row.key,
      result_id: row.id,
    });
  }
  const plan = f.repo.cli(['plan', '--json'], f.env);
  expect(plan.code).toBe(0);
  expect(JSON.parse(plan.out).map((r: { state: string }) => r.state)).toEqual(
    ids.map(() => 'PROVEN'),
  );
}, 15000);

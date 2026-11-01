import { expect, test } from 'bun:test';
import { fixture, spawn, stop, task, until, wait } from './support/jobs';

function setup(
  commands: Record<string, string>,
  providers = {},
  lanes: Record<string, number> = { ios: 2 },
) {
  const tasks = Object.fromEntries(
    Object.entries(commands).map(([id, run]) => [
      id,
      {
        ...task(run, Object.keys(providers)),
        lane: id.startsWith('other') ? 'other' : 'ios',
      },
    ]),
  );
  return fixture(tasks, providers, {
    'proof.yaml': JSON.stringify({ version: 1, project: 'jobs', tasks, providers, lanes }),
  });
}
async function finish(running: ReturnType<typeof spawn>, code = 0) {
  await until(() => running.child.exitCode !== null);
  const [out, err] = await running.output;
  expect(await running.child.exited, out + err).toBe(code);
  return out + err;
}
const mark = (id: string) => `echo "$PROOF_LANE_SLOT" > scratch/${id}`;

test('RUN tasks allocate lowest free slots independently per lane', async () => {
  const f = setup(
    {
      a: `${mark('a')}; ${wait('release-a')}`,
      b: `${mark('b')}; ${wait('release-b')}`,
      c: mark('c'),
      otherA: `${mark('otherA')}; ${wait('release-a')}`,
      otherB: `${mark('otherB')}; ${wait('release-b')}`,
    },
    {},
    { ios: 2, other: 2 },
  );
  const running = spawn(f, '--jobs', '4');
  try {
    await until(() => ['a', 'b', 'otherA', 'otherB'].every(f.has));
    for (const prefix of ['', 'other']) {
      const names = prefix ? ['otherA', 'otherB'] : ['a', 'b'];
      expect(names.map((name) => f.read(name).trim()).sort()).toEqual(['0', '1']);
    }
    f.mark('release-a');
    await until(() => f.has('c'));
    expect(f.read('c').trim()).toBe(f.read('a').trim());
    f.mark('release-b');
    await finish(running);
  } finally {
    f.mark('release-a');
    f.mark('release-b');
    await stop(running.child);
  }
  const plain = fixture({ t: task(mark('plain')), solo: { ...task(mark('solo')), lane: 'solo' } });
  expect(plain.repo.cli(['run'], { ...plain.env, PROOF_LANE_SLOT: '99' }).code).toBe(0);
  expect(plain.read('plain').trim()).toBe('');
  expect(plain.read('solo').trim()).toBe('');
});

const stack = {
  lane: 'ios',
  start:
    'echo start >> scratch/start-$PROOF_LANE_SLOT; echo ADDRESS=instance-$PROOF_LANE_SLOT > "$PROOF_PROVIDER_ENV"',
  stop: 'test -z "$PROOF_PROVIDER_ENV$ADDRESS" && echo stop >> scratch/stop-$PROOF_LANE_SLOT',
};
const addressed = (id: string) => `test "$ADDRESS" = "instance-$PROOF_LANE_SLOT" && ${mark(id)}`;

for (const jobs of [1, 2]) {
  test(`provider instances follow used slots with jobs=${jobs}`, async () => {
    const f = setup(
      {
        a: `${addressed('a')} || exit 1; ${jobs === 2 ? wait('b') : 'true'}`,
        b: `${addressed('b')} || exit 1; ${wait('release')}`,
      },
      { stack },
    );
    const running = spawn(f, '--jobs', String(jobs));
    try {
      await until(() => f.has('b') || running.child.exitCode !== null);
      expect(f.has('b')).toBe(true);
      expect(f.read('a').trim()).toBe('0');
      expect(f.read('b').trim()).toBe(jobs === 1 ? '0' : '1');
      expect(f.has('stop-0') || f.has('stop-1')).toBe(false);
      f.mark('release');
      await finish(running);
      for (let slot = 0; slot < jobs; slot++) {
        expect(f.read(`start-${slot}`)).toBe('start\n');
        expect(f.read(`stop-${slot}`)).toBe('stop\n');
      }
      expect(f.rows().map((row) => row.outcome)).toEqual(['green', 'green']);
    } finally {
      f.mark('release');
      await stop(running.child);
    }
  });
}

test('PROVEN dependents hold no slot and start no instance', () => {
  const f = setup({ a: addressed('a'), b: addressed('b') }, { stack });
  expect(f.repo.cli(['record', 'a', '--outcome', 'green'], f.env).code).toBe(0);
  expect(f.run('--jobs', '2').code).toBe(0);
  expect(f.has('a')).toBe(false);
  expect(f.read('b').trim()).toBe('0');
  expect(f.has('start-1')).toBe(false);
  const before = f.read('start-0');
  expect(f.run('--jobs', '2').code).toBe(0);
  expect(f.read('start-0')).toBe(before);
  expect(f.rows()).toHaveLength(2);
});

test('exports from distinct providers conflict even across lane instances', () => {
  const f = setup(
    { a: addressed('a') },
    {
      stack,
      shared: {
        start: 'echo ADDRESS=other > "$PROOF_PROVIDER_ENV"',
      },
    },
  );
  const result = f.run();
  expect(result.code).toBe(1);
  expect(result.out).toContain("conflicts with provider 'stack'");
  expect(f.has('a')).toBe(false);
  expect(f.rows()[0]?.outcome).toBe('incomplete');
});

test('failed slot retires capacity while healthy slot serves later tasks', async () => {
  const f = setup(
    {
      a: `${addressed('a')}; ${wait('release')}`,
      b: addressed('b'),
      c: addressed('c'),
      d: addressed('d'),
    },
    {
      stack: {
        ...stack,
        start: `${stack.start}; if test "$PROOF_LANE_SLOT" = 1; then ${wait('a')}; touch scratch/failed; exit 1; fi`,
      },
    },
  );
  const running = spawn(f, '--jobs', '2');
  try {
    await until(() => f.has('failed') && f.rows().some((r) => r.task === 'b'));
    await Bun.sleep(300);
    expect(f.rows().map((r) => r.task)).toEqual(['b']);
    expect(f.has('c') || f.has('d')).toBe(false);
    expect(f.read('start-1')).toBe('start\n');
    f.mark('release');
    expect(await finish(running, 1)).toContain("provider 'stack[1]' start failed");
    expect(f.read('c').trim()).toBe('0');
    expect(f.read('d').trim()).toBe('0');
    expect(
      f
        .rows()
        .map((r) => [r.task, r.outcome])
        .sort(),
    ).toEqual([
      ['a', 'green'],
      ['b', 'incomplete'],
      ['c', 'green'],
      ['d', 'green'],
    ]);
    expect(f.read('stop-0')).toBe('stop\n');
    expect(f.read('stop-1')).toBe('stop\n');
  } finally {
    f.mark('release');
    await stop(running.child);
  }
});

for (const limit of [1, 2]) {
  test(`exhausted lane records incomplete, limit=${limit}`, () => {
    const tasks = Object.fromEntries(
      ['a', 'b', 'c'].map((id) => [
        id,
        {
          ...task(mark(id), id === 'c' ? [] : ['stack']),
          lane: 'ios',
        },
      ]),
    );
    const providers = { stack: { ...stack, start: `${stack.start}; exit 1` } };
    const f = fixture(tasks, providers, {
      'proof.yaml': JSON.stringify({
        version: 1,
        project: 'jobs',
        tasks,
        providers,
        lanes: { ios: limit },
      }),
    });
    const result = f.run('--jobs', '2');
    expect(result.code).toBe(1);
    expect(result.out).toContain("lane 'ios' exhausted");
    expect(['a', 'b', 'c'].some(f.has)).toBe(false);
    expect(f.rows().map((r) => r.outcome)).toEqual(['incomplete', 'incomplete', 'incomplete']);
    for (let slot = 0; slot < limit; slot++) {
      expect(f.read(`start-${slot}`)).toBe('start\n');
      expect(f.read(`stop-${slot}`)).toBe('stop\n');
    }
  });
}

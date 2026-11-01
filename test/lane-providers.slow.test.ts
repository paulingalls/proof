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
      await until(() => (f.has('a') && f.has('b')) || running.child.exitCode !== null);
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
      ['a', 'b', 'c', 'd'].map((id) => [
        id,
        {
          ...task(mark(id), ['c', 'd'].includes(id) ? [] : ['stack']),
          inputs: [id === 'd' ? 'missing' : 'input'],
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
    expect(['a', 'b', 'c', 'd'].some(f.has)).toBe(false);
    expect(result.out).toMatch(/incomplete d;.*lane 'ios' exhausted/);
    expect(f.rows().map((r) => r.outcome)).toEqual(['incomplete', 'incomplete', 'incomplete']);
    for (let slot = 0; slot < limit; slot++) {
      expect(f.read(`start-${slot}`)).toBe('start\n');
      expect(f.read(`stop-${slot}`)).toBe('stop\n');
    }
  });
}

for (const limit of [1, 3]) {
  test(`runtime lane override replaces limit with ${limit}, preserving other lanes`, async () => {
    const f = setup(
      Object.fromEntries(
        ['a', 'b', 'c', 'otherA', 'otherB'].map((id) => [id, `${mark(id)}; ${wait('release')}`]),
      ),
      {},
      { ios: 2, other: 2 },
    );
    Object.assign(f.env, { PROOF_LANES: `ios=${limit}` });
    const running = spawn(f, '--fresh', '--jobs', '5');
    try {
      const expected = [...['a', 'b', 'c'].slice(0, limit), 'otherA', 'otherB'];
      await until(() => expected.every(f.has));
      await Bun.sleep(300);
      expect(['a', 'b', 'c'].filter(f.has)).toHaveLength(limit);
      expect(
        expected
          .filter((id) => !id.startsWith('other'))
          .map((id) => f.read(id).trim())
          .sort(),
      ).toEqual(Array.from({ length: limit }, (_, i) => String(i)));
      expect(['otherA', 'otherB'].map((id) => f.read(id).trim()).sort()).toEqual(['0', '1']);
      f.mark('release');
      await finish(running);
    } finally {
      f.mark('release');
      await stop(running.child);
    }
  });
}

test('runtime lane overrides reject malformed values before starting even proven or empty runs', () => {
  const f = setup({ a: mark('a') }, { stack });
  expect(f.repo.cli(['record', 'a', '--outcome', 'green'], f.env).code).toBe(0);
  const empty = fixture({});
  for (const value of [
    '',
    'ios',
    '=1',
    'ios=',
    'ios=0',
    'ios=-1',
    'ios=1.5',
    'ios=x',
    'ios=01',
    'ios=9007199254740992',
    'ios=1=2',
    ',ios=1',
    'ios=1,',
    'ios=1,,ios=2',
    'ios=1,ios=2',
    ' ios=1',
    'ios=1 ',
    'ios=1\n',
    'ios=1\r\n',
    'missing=1',
    'solo=1',
  ]) {
    const result = f.repo.cli(['run', '--jobs', '2'], { ...f.env, PROOF_LANES: value });
    expect(result.code, value + result.out + result.err).toBe(2);
    expect(result.err).toContain('PROOF_LANES');
    expect(f.has('start-0')).toBe(false);
  }
  for (const value of ['ios=x', 'missing=1'])
    expect(empty.repo.cli(['run'], { ...empty.env, PROOF_LANES: value }).code).toBe(2);
});

test('keys survive actual slot changes, declared limits and runtime overrides', async () => {
  const f = setup(
    { a: `${addressed('a')}; ${wait('b')}`, b: `${addressed('b')}; ${wait('release')}` },
    { stack },
  );
  const running = spawn(f, '--fresh', '--jobs', '2');
  try {
    await until(() => f.has('b'));
    expect(f.read('b').trim()).toBe('1');
    f.mark('release');
    await finish(running);
  } finally {
    f.mark('release');
    await stop(running.child);
  }
  expect(f.run('--fresh', '--jobs', '1', '--tasks', 'b').code).toBe(0);
  expect(f.read('b').trim()).toBe('0');
  const keys = f
    .rows()
    .filter((r) => r.task === 'b')
    .map((r) => r.key);
  expect(keys).toHaveLength(2);
  expect(new Set(keys).size).toBe(1);
  const declaration = JSON.parse(f.repo.git('show', 'HEAD:proof.yaml'));
  declaration.lanes.ios = 1;
  f.repo.commit({ 'proof.yaml': JSON.stringify(declaration) });
  const before = f.read('start-0');
  for (const override of [undefined, 'ios=3']) {
    const result = f.repo.cli(['run', '--jobs', '3', '--tasks', 'b'], {
      ...f.env,
      PROOF_LANES: override,
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain('PROVEN b');
    expect(f.read('start-0')).toBe(before);
  }
  expect(
    f.repo.cli(['run', '--staged', '--jobs', '3', '--tasks', 'b'], {
      ...f.env,
      PROOF_LANES: 'ios=3',
    }).out,
  ).toContain('PROVEN b');
});

test('literal provider names cannot alias slot instance identities', () => {
  const f = setup(
    { a: `${addressed('a')} && test "$OTHER" = unlaned` },
    {
      stack,
      'stack[0]': {
        start: 'test -z "$PROOF_LANE_SLOT" && echo OTHER=unlaned > "$PROOF_PROVIDER_ENV"',
        stop: 'test -z "$PROOF_LANE_SLOT" && touch scratch/unlaned-stop',
      },
    },
  );
  expect(f.repo.cli(['run'], { ...f.env, PROOF_LANE_SLOT: '99' }).code).toBe(0);
  expect(f.has('unlaned-stop')).toBe(true);
  expect(f.rows()[0]?.outcome).toBe('green');
});

test('staged startup of a later instance remembers unstaged bytes it restored', async () => {
  const providers = {
    stack: {
      lane: 'ios',
      start: `if test "$PROOF_LANE_SLOT" = 1; then cp input scratch/seen; git show :input > input; fi; touch scratch/up-$PROOF_LANE_SLOT`,
    },
  };
  const tasks = {
    a: { ...task(wait('release'), ['stack']), lane: 'ios' },
    held: { ...task(wait('edited')), lane: 'ios' },
    b: { ...task('true', ['stack']), lane: 'ios' },
  };
  const f = fixture(tasks, providers, {
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'jobs',
      tasks,
      providers,
      lanes: { ios: 2 },
    }),
  });
  const running = spawn(f, '--staged', '--jobs', '2');
  try {
    await until(() => f.has('up-0'));
    f.repo.write('input', 'unstaged');
    f.mark('edited');
    await until(() => f.has('seen'));
    await until(() => f.rows().some((r) => r.task === 'b'));
    f.mark('release');
    const output = await finish(running);
    expect(f.read('seen')).toBe('unstaged');
    expect(output).toContain("green b; no proof published: provider can see unstaged 'input'");
  } finally {
    f.mark('release');
    f.mark('edited');
    await stop(running.child);
  }
});

import { expect, test } from 'bun:test';
import { fixture, spawn, stop, task, until } from './support/jobs';

const declaration = (tasks: unknown, extra = {}) =>
  JSON.stringify({ version: 1, project: 'jobs', tasks, ...extra });

test('lane declaration errors reach every declaration reader', () => {
  const f = fixture({ t: task('true') });
  for (const [extra, lane, message, all] of [
    [{}, 'missing', "unknown lane 'missing'", true],
    [{ lanes: { solo: 1 } }, undefined, "lane 'solo': reserved", true],
    [{ lanes: { ios: 0 } }, undefined, "lane 'ios': expected a positive safe integer", true],
    ...[-1, 1.5, '2', null, 9007199254740992].map((limit) => [
      { lanes: { ios: limit } },
      undefined,
      "lane 'ios': expected a positive safe integer",
      false,
    ]),
    [{ lanes: [] }, undefined, 'lanes: expected a mapping', false],
    [{ lanes: null }, undefined, 'lanes: expected a mapping', false],
    [{}, '', 'lane: expected a nonempty string', false],
  ] as const) {
    f.repo.commit({ 'proof.yaml': declaration({ t: { ...task('true'), lane } }, extra) });
    f.repo.write('.git/cases.yaml', '[{"name":"same","from":"HEAD","to":"HEAD","expect":[]}]');
    for (const command of all
      ? [
          'plan',
          'run',
          'record t --outcome green',
          'why t',
          'status --ref HEAD',
          'lint',
          'doctor',
          'check .git/cases.yaml',
        ]
      : ['lint']) {
      const result = f.repo.cli(command.split(' '), f.env);
      expect(result.code, command + result.err).toBe(2);
      expect(result.err).toContain(message as string);
    }
  }
  f.repo.commit({
    'proof.yaml': declaration({}, { include: 'proof.d/*.yaml' }),
    'proof.d/tasks.yaml': JSON.stringify({ tasks: { t: { ...task('true'), lane: 'missing' } } }),
  });
  expect(f.repo.cli(['lint'], f.env).err).toContain("task 't': unknown lane 'missing'");
}, 30000);

test('included lanes and solo parse; scheduling metadata preserves existing proof', () => {
  const f = fixture({ t: task('true') });
  expect(f.repo.cli(['record', 't', '--outcome', 'green'], f.env).code).toBe(0);
  for (const [lane, lanes] of [
    ['ios', { ios: 2 }],
    ['solo', {}],
    ['ios', { ios: 1 }],
  ] as const) {
    f.repo.commit({
      'proof.yaml': declaration({}, { lanes, include: 'proof.d/*.yaml' }),
      'proof.d/tasks.yaml': JSON.stringify({ tasks: { t: { ...task('true'), lane } } }),
    });
    const result = f.repo.cli(['plan', '--json'], f.env);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject([{ task: 't', state: 'PROVEN' }]);
  }
  f.repo.commit({ 'proof.yaml': declaration({ t: { ...task('true'), lane: 'solo' } }) });
  expect(f.run().code).toBe(0);
});

const script = `import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
const [id, release] = process.argv.slice(2);
const deadline = Date.now() + 6000;
async function wait(check) {
  while (!check()) {
    if (Date.now() > deadline) throw new Error('fixture deadline: ' + id);
    await Bun.sleep(10);
  }
}
async function event(kind) {
  await wait(() => {
    try { mkdirSync('scratch/lock'); return true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; return false; }
  });
  try {
    const events = existsSync('scratch/events') ? JSON.parse(readFileSync('scratch/events', 'utf8')) : [];
    events.push([id, kind]);
    writeFileSync('scratch/next', JSON.stringify(events));
    renameSync('scratch/next', 'scratch/events');
  } finally { rmdirSync('scratch/lock'); }
}
await event('enter');
await wait(() => existsSync('scratch/' + release));
await event('exit');`;
type Event = [string, string];
function concurrent(lanes: Record<string, number>, roster: [string, string?, string?][]) {
  const tasks = Object.fromEntries(
    roster.map(([id, lane, release = 'release']) => [
      id,
      {
        ...task(`'${process.execPath}' fixture.ts ${id} ${release}`),
        inputs: ['input', 'fixture.ts'],
        lane,
      },
    ]),
  );
  const f = fixture(
    tasks,
    {},
    {
      'proof.yaml': declaration(tasks, { lanes }),
      'fixture.ts': script,
    },
  );
  const events = (): Event[] => (f.has('events') ? JSON.parse(f.read('events')) : []);
  const entered = (...ids: string[]) =>
    until(() => ids.every((id) => events().some(([who, kind]) => who === id && kind === 'enter')));
  return { ...f, events, entered };
}
async function finish(f: ReturnType<typeof concurrent>, running: ReturnType<typeof spawn>) {
  await until(() => running.child.exitCode !== null);
  const [out, err] = await running.output;
  expect(await running.child.exited, out + err).toBe(0);
  const active = new Set<string>();
  let peak = 0;
  let iosPeak = 0;
  for (const [id, kind] of f.events()) {
    if (kind === 'enter') {
      expect(active.has(id)).toBe(false);
      active.add(id);
    } else {
      expect(active.delete(id)).toBe(true);
    }
    expect(active.has('solo') && active.size > 1).toBe(false);
    peak = Math.max(peak, active.size);
    iosPeak = Math.max(iosPeak, [...active].filter((id) => 'abc'.includes(id)).length);
  }
  expect(active.size).toBe(0);
  const ids = f
    .rows()
    .map((r) => r.task)
    .sort();
  expect(f.rows().every((r) => r.outcome === 'green')).toBe(true);
  expect(
    f
      .events()
      .filter(([, kind]) => kind === 'enter')
      .map(([id]) => id)
      .sort(),
  ).toEqual(ids);
  expect(
    f
      .events()
      .filter(([, kind]) => kind === 'exit')
      .map(([id]) => id)
      .sort(),
  ).toEqual(ids);
  return { peak, iosPeak, ids };
}

for (const bypass of [false, true]) {
  test(`lane capacity bounds three tasks and bypasses saturated lane=${bypass}`, async () => {
    const f = concurrent({ ios: 2 }, [
      ['a', 'ios'],
      ['b', 'ios'],
      ['c', 'ios'],
      ...(bypass ? ([['d']] as [string][]) : []),
    ]);
    const running = spawn(f, '--jobs', '3');
    try {
      await f.entered('a', 'b', ...(bypass ? ['d'] : []));
      await Bun.sleep(300);
      expect(
        f
          .events()
          .map(([id]) => id)
          .sort(),
      ).toEqual(bypass ? ['a', 'b', 'd'] : ['a', 'b']);
      f.mark('release');
      expect(await finish(f, running)).toEqual({
        peak: bypass ? 3 : 2,
        iosPeak: 2,
        ids: bypass ? ['a', 'b', 'c', 'd'] : ['a', 'b', 'c'],
      });
    } finally {
      f.mark('release');
      await stop(running.child);
    }
  }, 15000);
}

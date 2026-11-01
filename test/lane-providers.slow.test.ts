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

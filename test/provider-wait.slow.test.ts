import { expect, test } from 'bun:test';
import { fixture, spawn, stop, task, until, wait } from './support/jobs';

const worker = `import { existsSync, writeFileSync } from 'node:fs';
const [id, barrier, delay] = process.argv.slice(2);
const start = Date.now();
writeFileSync('scratch/' + id, String(start));
writeFileSync('scratch/slot-' + id, process.env.PROOF_LANE_SLOT ?? '');
const deadline = Date.now() + 5000;
while (barrier && !existsSync('scratch/' + barrier) && Date.now() < deadline) await Bun.sleep(10);
await Bun.sleep(Number(delay ?? 0));
writeFileSync('scratch/end-' + id, String(Date.now()));`;
const command = (id: string, barrier = '', delay = 0, needs: string[] = []) => ({
  ...task(`'${process.execPath}' worker.ts ${id} '${barrier}' ${delay}`, needs),
  inputs: ['input', 'worker.ts'],
});
const files = { 'worker.ts': worker };
async function finish(running: ReturnType<typeof spawn>, code = 0) {
  await until(() => running.child.exitCode !== null);
  const [out, err] = await running.output;
  expect(await running.child.exited, out + err).toBe(code);
  return out;
}

test('independent commands overlap and finish during provider startup', async () => {
  const f = fixture(
    { a: command('a', '', 0, ['p']), b: command('b', 'c', 1000), c: command('c', 'b', 1000) },
    { p: { start: 'sleep 3' } },
    files,
  );
  const running = spawn(f, '--jobs', '2');
  try {
    const out = await finish(running);
    const ready = out.indexOf("provider 'p' start ready");
    for (const id of ['b', 'c']) {
      const progress = out.search(new RegExp(`^progress: .*; task ${id}$`, 'm'));
      expect(progress).toBeGreaterThan(-1);
      expect(progress).toBeLessThan(ready);
    }
    expect(out.search(/^progress: .*; task a$/m)).toBeGreaterThan(ready);
    expect(out).toContain('summary: green 3');
  } finally {
    await stop(running.child);
  }
}, 15000);

for (const interrupt of [false, true]) {
  test(`ready dependents wait for command capacity; interrupt=${interrupt}`, async () => {
    const f = fixture(
      {
        a: command('a', '', 0, ['p']),
        b: command('b', '', 0, ['p']),
        c: command('c', 'release'),
        d: command('d', 'release'),
      },
      {
        p: {
          start: `sleep 2; '${process.execPath}' worker.ts ready`,
          stop: 'echo stop >> scratch/stops',
        },
      },
      files,
    );
    const running = spawn(f, '--jobs', '2');
    try {
      await until(() => f.has('ready'));
      await Bun.sleep(200);
      expect(['c', 'd'].filter(f.has)).toEqual(['c', 'd']);
      for (const id of ['c', 'd']) expect(Number(f.read(id))).toBeLessThan(Number(f.read('ready')));
      expect(f.has('a') || f.has('b')).toBe(false);
      if (interrupt) running.child.kill('SIGINT');
      else f.mark('release');
      const out = await finish(running, interrupt ? 130 : 0);
      expect(out.match(/^provider 'p' start ready/gm)).toHaveLength(1);
      expect(f.read('stops')).toBe('stop\n');
      if (interrupt) {
        expect(f.has('a') || f.has('b')).toBe(false);
        expect(out).toContain('summary: green 0, red 0, incomplete 4');
      } else {
        const events = ['a', 'b', 'c', 'd']
          .flatMap((id) => [
            { time: Number(f.read(id)), delta: 1 },
            { time: Number(f.read(`end-${id}`)), delta: -1 },
          ])
          .sort((a, b) => a.time - b.time || a.delta - b.delta);
        let active = 0;
        for (const event of events) {
          active += event.delta;
          expect(active).toBeLessThanOrEqual(2);
        }
        expect(active).toBe(0);
        expect(out).toContain('summary: green 4');
      }
    } finally {
      f.mark('release');
      await stop(running.child);
    }
  }, 15000);
}

test('provider wait retains the lane slot and reuses its instance', async () => {
  const tasks = {
    a: { ...command('a', 'release-a', 0, ['p']), lane: 'ios' },
    b: { ...command('b', '', 0, ['p']), lane: 'ios' },
    c: command('c', 'release'),
    d: command('d', 'release'),
  };
  const providers = {
    p: {
      lane: 'ios',
      start: `${wait('start')}; echo start >> scratch/starts`,
      stop: 'touch scratch/stopped',
    },
  };
  const f = fixture(tasks, providers, {
    ...files,
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'jobs',
      tasks,
      providers,
      lanes: { ios: 1 },
    }),
  });
  const running = spawn(f, '--jobs', '2');
  try {
    await until(() => f.has('c') || f.has('d'));
    await Bun.sleep(200);
    expect(f.has('c') && f.has('d')).toBe(true);
    expect(f.has('a') || f.has('b')).toBe(false);
    f.mark('release');
    f.mark('start');
    await until(() => f.has('a'));
    expect(f.has('b') || f.has('stopped')).toBe(false);
    f.mark('release-a');
    const out = await finish(running);
    expect(f.read('slot-a')).toBe('0');
    expect(f.read('slot-b')).toBe('0');
    expect(Number(f.read('b'))).toBeGreaterThanOrEqual(Number(f.read('end-a')));
    expect(f.read('starts')).toBe('start\n');
    expect(f.has('stopped')).toBe(true);
    expect(out).toContain('summary: green 4');
  } finally {
    for (const marker of ['release', 'start', 'release-a']) f.mark(marker);
    await stop(running.child);
  }
}, 15000);

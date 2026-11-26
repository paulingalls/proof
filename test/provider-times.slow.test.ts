import { expect, test } from 'bun:test';
import { fixture, stop, task, until, wait } from './support/jobs';

const iso = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`;
const timing = (phase: string) =>
  new RegExp(`^provider 'p' ${phase} (\\d+\\.\\d)s, (${iso})\\.\\.(${iso})$`, 'gm');

test('provider timings arrive at completion while unrelated work remains held', async () => {
  const f = fixture(
    { dependent: task(wait('release-dependent'), ['p']), unrelated: task(wait('release-other')) },
    { p: { start: 'sleep 1', stop: 'true' } },
  );
  const child = f.repo.spawnCli(['run', '--jobs', '2'], f.env);
  let out = '';
  const reading = (async () => {
    for await (const chunk of child.stdout) out += Buffer.from(chunk).toString();
  })();
  const stderr = new Response(child.stderr).text();
  try {
    await until(() => timing('start ready').test(out) || child.exitCode !== null);
    expect(out.match(timing('start ready'))).toHaveLength(1);
    expect(child.exitCode).toBeNull();
    expect(out).not.toContain('; task dependent');
    f.mark('release-dependent');
    await until(() => timing('stop done').test(out) || child.exitCode !== null);
    expect(out.match(timing('stop done'))).toHaveLength(1);
    expect(child.exitCode).toBeNull();
    f.mark('release-other');
    expect(await child.exited).toBe(0);
    await reading;
    expect(await stderr).toBe('');
    for (const phase of ['start ready', 'stop done'] as const) {
      const matches = [...out.matchAll(timing(phase))];
      expect(matches).toHaveLength(1);
      const [, seconds, start, end] = matches[0] as RegExpMatchArray;
      const duration = (Date.parse(end as string) - Date.parse(start as string)) / 1000;
      expect(duration).toBeGreaterThanOrEqual(0);
      expect(Math.abs(duration - Number(seconds))).toBeLessThanOrEqual(0.1);
      if (phase === 'start ready') expect(Number(seconds)).toBeGreaterThanOrEqual(1);
    }
    expect(out.search(timing('start ready'))).toBeLessThan(out.indexOf('; task dependent'));
    expect(out.search(timing('stop done'))).toBeLessThan(out.indexOf('summary:'));
    expect(out).toContain('summary: green 2, red 0, incomplete 0, proven 0, unreached 0');
  } finally {
    f.mark('release-dependent');
    f.mark('release-other');
    await stop(child);
    await reading;
  }
}, 15_000);

test('serial ready timing precedes live task output and absent stop emits no line', () => {
  const f = fixture({ t: task('echo task-live-marker', ['p']) }, { p: { start: 'true' } });
  const result = f.run('--jobs', '1');
  expect(result.code).toBe(0);
  expect(result.out.match(timing('start ready'))).toHaveLength(1);
  expect(result.out.search(timing('start ready'))).toBeLessThan(
    result.out.indexOf('task-live-marker'),
  );
  expect(result.out).not.toContain("provider 'p' stop");
});

for (const [start, stopCommand, phase] of [
  ['kill -KILL $$', 'true', 'start incomplete'],
  ['true', 'exit 1', 'stop failed'],
] as const) {
  test(`reports ${phase} timing`, () => {
    const f = fixture({ t: task('true', ['p']) }, { p: { start, stop: stopCommand } });
    const result = f.run();
    expect(result.code).toBe(1);
    expect(result.out.match(timing(phase))).toHaveLength(1);
  });
}

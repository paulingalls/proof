import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { Repo } from './support/repo';

test('root delivery keeps runner peak RSS within 24 MB of selection only', () => {
  const r = new Repo();
  try {
    for (let i = 0; i < 384; i++) {
      r.write(
        `payload/${i}`,
        String(i)
          .padStart(8, '0')
          .repeat(16 * 1024),
      );
    }
    const tasks = Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [
        `task-${i}`,
        { run: 'test "$(cat source)" = selected && sleep 1', inputs: ['source'] },
      ]),
    );
    const doc = { version: 1, project: 'sandbox-memory', tasks };
    r.commit({ source: 'selected', 'proof.yaml': JSON.stringify(doc) });
    const run = (state: string) => {
      const result = r.cli(['run', '--jobs', '2'], {
        PROOF_STATE_DIR: join(r.path, '.git', state),
      });
      expect(result.code, result.err + result.out).toBe(0);
      for (const name of Object.keys(tasks)) {
        expect(result.out).toContain(`green ${name}; proof published`);
      }
      if (typeof result.maxRSS !== 'number') throw new Error('missing runner max RSS');
      return result.maxRSS;
    };
    const baselineRSS = run('baseline');
    r.commit({ 'proof.yaml': JSON.stringify({ ...doc, delivered: ['**'] }) });
    const deliveredRSS = run('delivered');
    const delta = deliveredRSS - baselineRSS;
    const measurements = `baseline=${baselineRSS}, delivered=${deliveredRSS}, delta=${delta} bytes`;
    console.log(measurements);
    for (const rss of [baselineRSS, deliveredRSS]) {
      expect(Number.isFinite(rss), measurements).toBe(true);
      expect(rss, measurements).toBeGreaterThan(8 * 1024 * 1024);
    }
    expect(delta, measurements).toBeLessThan(24_000_000);
  } finally {
    r.close();
  }
}, 60_000);

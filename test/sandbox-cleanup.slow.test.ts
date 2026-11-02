import { expect, test } from 'bun:test';
import { chmodSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, task } from './support/jobs';

test('a sandbox that will not delete warns and costs no other task', () => {
  const f = fixture({
    target: task('mkdir stuck; touch stuck/file; chmod 555 stuck'),
    sibling: task('sleep 0.3'),
    queued: task('true'),
  });
  const result = f.run('--jobs', '2');
  expect(result.code, result.out).toBe(0);
  for (const id of ['target', 'sibling', 'queued'])
    expect(result.out).toContain(`green ${id}; proof published`);
  const warnings = result.out.split('\n').filter((line) => line.startsWith('warning:'));
  expect(warnings).toHaveLength(1);
  const path = /^warning: sandbox cleanup failed for target; left behind: ([^;]+); /.exec(
    warnings[0] as string,
  )?.[1] as string;
  expect(existsSync(path)).toBe(true);
  chmodSync(join(path, 'stuck'), 0o755);
  rmSync(path, { recursive: true, force: true });
});

import { expect, test } from 'bun:test';
import { fixture, task } from './support/jobs';

for (const [jobs, values] of [
  ['1', ['0']],
  ['2', ['x', '1.5', '01']],
] as const) {
  for (const value of values) {
    test(`PROOF_CPUS=${JSON.stringify(value)} fails before tasks with jobs ${jobs}`, () => {
      const f = fixture({ a: task('touch scratch/ran') });
      const result = f.repo.cli(['run', '--jobs', jobs], { ...f.env, PROOF_CPUS: value });
      expect(result.code).toBe(2);
      expect(result.err).toContain('PROOF_CPUS');
      expect(f.has('ran')).toBe(false);
    });
  }
}

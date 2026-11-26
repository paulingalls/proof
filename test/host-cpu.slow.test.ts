import { expect, test } from 'bun:test';
import { fixture, task } from './support/jobs';

for (const jobs of ['1', '2']) {
  for (const value of ['0', 'x', '-1', '1.5', '', '9007199254740992', '01', ' 2', '1e2']) {
    test(`PROOF_CPUS=${JSON.stringify(value)} fails before tasks with jobs ${jobs}`, () => {
      const f = fixture({ a: task('touch scratch/ran') });
      const result = f.repo.cli(['run', '--jobs', jobs], { ...f.env, PROOF_CPUS: value });
      expect(result.code).toBe(2);
      expect(result.err).toContain('PROOF_CPUS');
      expect(f.has('ran')).toBe(false);
    });
  }
}

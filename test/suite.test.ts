import { afterEach, expect, test } from 'bun:test';
import { Repo } from './support/repo';
import { suiteCases, suiteFixture } from './support/suite';

const repos: Repo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
});

test('requirement suite selects exact RUN sets for cases 4, 9, 10 and 12', () => {
  const r = new Repo();
  repos.push(r);
  const baseline = suiteFixture(r);
  const cases = suiteCases(r, baseline);
  const result = r.check(cases);
  expect(result.code).toBe(0);
  expect(result.err).toBe('');
  expect(result.out).toBe('PASS baseline\nPASS case 4\nPASS case 9\nPASS case 10\nPASS case 12\n');
});

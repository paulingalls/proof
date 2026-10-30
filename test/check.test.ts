import { afterEach, expect, test } from 'bun:test';
import { Repo } from './support/repo';

const repos: Repo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
});
function repo() {
  const r = new Repo();
  repos.push(r);
  return r;
}
const declaration = `version: 1
project: fixture
tasks:
  lint:
    run: exit 99
    inputs: [src/**]
  docs-check:
    run: exit 99
    inputs: [docs/guide/**]
`;
function baseline(r: Repo, yaml = declaration) {
  return r.commit({
    'proof.yaml': yaml,
    'src/a.ts': 'a',
    'docs/guide/start.md': 'guide',
    'CHANGELOG.md': 'log',
    'scripts/tiers.md': 'tiers',
  });
}
function item(name: string, from: string, to: string, expected: string[] = []) {
  return { name, from, to, expect: expected };
}

test('checks exact RUN sets, new tasks, and reports mismatches while continuing', () => {
  const r = repo();
  const a = baseline(r);
  const b = r.commit({ 'CHANGELOG.md': 'log2' });
  const c = r.commit({ 'src/a.ts': 'b' });
  const d = r.commit({ 'docs/research/r.md': 'research' });
  const e = r.commit({ 'scripts/tiers.md': 'tiers2' });
  const f = r.commit({
    'proof.yaml': `${declaration}  added:\n    run: exit 99\n    inputs: [src/**]\n`,
  });
  const cases = [
    item('changelog', a, b),
    item('source', b, c, ['lint']),
    item('research', c, d),
    item('tiers', d, e),
    item('new task', e, f, ['added']),
  ];
  const result = r.check(cases);
  expect(result.err).toBe('');
  expect(result.code).toBe(0);
  for (const c of cases) expect(result.out).toContain(`PASS ${c.name}`);
  const wrong = r.check([item('wrong', b, c, ['docs-check']), cases[0]]);
  expect(wrong.code).toBe(1);
  expect(wrong.out).toContain('FAIL wrong');
  expect(wrong.out).toContain('missing: docs-check');
  expect(wrong.out).toContain('extra: lint');
  expect(wrong.out).toContain('PASS changelog');
});

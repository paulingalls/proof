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

test('keys reflect selected paths and command meaning, not positive order or set names', () => {
  const r = repo();
  const yaml = (name: string, inputs: string, run = 'exit 99') => `version: 1
project: fixture
inputs:
  ${name}: [src/**]
tasks:
  lint:
    run: ${run}
    inputs: ${inputs}
`;
  const a = baseline(r, yaml('source', '[$source, docs/guide/**]'));
  const b = r.commit({ 'proof.yaml': yaml('renamed', '[docs/guide/**, $renamed]') });
  const c = r.commit({ 'src/a.ts': 'changed' });
  const d = r.commit({ 'proof.yaml': yaml('renamed', '[docs/guide/**, $renamed]', 'exit 98') });
  r.git('mv', 'src/a.ts', 'src/b.ts');
  const e = r.commit({});
  const result = r.check([
    item('equivalent', a, b),
    item('content', b, c, ['lint']),
    item('command', c, d, ['lint']),
    item('path', d, e, ['lint']),
  ]);
  expect(result.code).toBe(0);
  for (const name of ['equivalent', 'content', 'command', 'path']) {
    expect(result.out).toContain(`PASS ${name}`);
  }
});

test('applies negation in order over the complete inventory', () => {
  const r = repo();
  const excluded = declaration.replace('[src/**]', '["src/**", "!src/gen/**"]');
  baseline(r, excluded);
  const b = r.commit({ 'src/gen/g.ts': 'generated' });
  const c = r.commit({ 'src/gen/g.ts': 'changed' });
  const d = r.commit({
    'proof.yaml': excluded.replace('["src/**", "!src/gen/**"]', '["!src/gen/**", "src/**"]'),
  });
  const result = r.check([item('excluded bytes', b, c), item('order grows', c, d, ['lint'])]);
  expect(result.code).toBe(0);
  expect(result.out).toContain('PASS excluded bytes');
  expect(result.out).toContain('PASS order grows');
});

test('an unmatched input runs with its reason, including exclusions', () => {
  const r = repo();
  for (const pattern of ['missing/**', '!absent/**']) {
    const a = baseline(r, declaration.replace('[src/**]', `["src/**", "${pattern}"]`));
    const b = r.commit({ 'CHANGELOG.md': pattern });
    const result = r.check([item(pattern, a, b, ['lint'])]);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`PASS ${pattern}`);
    expect(result.out).toContain(`RUN lint: unmatched input '${pattern}'`);
  }
});

test('reads included declarations at each ref despite dirty checkout declarations', () => {
  const r = repo();
  const root = `${declaration}include: proof.d/*.yaml\n`;
  baseline(r, root);
  const a = r.commit({
    'proof.d/web.yaml': 'tasks:\n  web:\n    run: exit 99\n    inputs: [web/**]\n',
    'web/a.ts': 'web',
  });
  const b = r.commit({ 'web/a.ts': 'changed' });
  const cases = [item('web change', a, b, ['web'])];
  expect(r.check(cases).code).toBe(0);
  r.write('proof.yaml', ': invalid [');
  r.write('proof.d/web.yaml', ': invalid [');
  r.write('web/a.ts', 'dirty');
  const result = r.check(cases);
  expect(result.code).toBe(0);
  expect(result.out).toContain('PASS web change');
});

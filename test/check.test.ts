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
function based(yaml = declaration) {
  const r = Repo.from(`check:${yaml}`, (template) => baseline(template, yaml));
  repos.push(r);
  return { r, a: r.git('rev-parse', 'HEAD') };
}
function item(name: string, from: string, to: string, expected: string[] = []) {
  return { name, from, to, expect: expected };
}

test('checks exact RUN sets, new tasks, and reports mismatches while continuing', () => {
  const { r, a } = based();
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
    expect(result.out).toContain(`PASS ${pattern}\n  RUN lint: unmatched input '${pattern}'`);
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
  const c = r.commit({
    'proof.d/web.yaml': 'tasks:\n  web:\n    run: exit 98\n    inputs: [web/**]\n',
  });
  const cases = [item('web change', a, b, ['web']), item('included command', b, c, ['web'])];
  expect(r.check(cases).code).toBe(0);
  r.write('proof.yaml', ': invalid [');
  r.write('proof.d/web.yaml', ': invalid [');
  r.write('web/a.ts', 'dirty');
  const result = r.check(cases);
  expect(result.code).toBe(0);
  expect(result.out).toContain('PASS web change');
  expect(result.out).toContain('PASS included command');
});

test('schema errors identify offending declarations and refs override prior mismatches', () => {
  const { r, a } = based();
  const b = r.commit({
    'proof.yaml': declaration.replace('run: exit 99', 'surprise: true\n    run: exit 99'),
  });
  const result = r.check([item('bad task', a, b)]);
  expect(result.code).toBe(2);
  for (const word of ['proof.yaml', 'lint', 'surprise']) expect(result.err).toContain(word);
  for (const field of ['from', 'to']) {
    const c = { ...item('bad ref', a, a), [field]: '--unknown-ref' };
    const bad = r.check([item('wrong first', a, a, ['lint']), c]);
    expect(bad.code).toBe(2);
    expect(bad.out).toContain('FAIL wrong first');
    expect(bad.err).toContain('--unknown-ref');
  }
});

test('rejects silent declaration corruption at the CLI boundary', () => {
  const fixtures: [string, Record<string, string>, string[]][] = [
    [
      'duplicate task',
      { 'proof.d/web.yaml': 'tasks:\n  lint:\n    run: x\n    inputs: [src/**]' },
      ['duplicate', 'lint'],
    ],
    [
      'duplicate set',
      { 'proof.d/web.yaml': 'inputs:\n  source: [src/**]' },
      ['duplicate', 'source'],
    ],
    ['unknown set', { 'proof.yaml': declaration.replace('[src/**]', '[$unknown]') }, ['unknown']],
    [
      'cycle',
      {
        'proof.yaml': declaration
          .replace('tasks:', 'inputs:\n  a: [$b]\n  b: [$a]\ntasks:')
          .replace('[src/**]', '[$a]'),
      },
      ['cyclic', 'a'],
    ],
    [
      'unmatched include',
      { 'proof.yaml': `${declaration}include: absent/*.yaml\n` },
      ['include', 'absent/*.yaml'],
    ],
    ['empty inputs', { 'proof.yaml': declaration.replace('[src/**]', '[]') }, ['lint', 'inputs']],
    [
      'unquoted negation',
      { 'proof.yaml': declaration.replace('[src/**]', '\n      - !src/gen/**') },
      ['lint', 'quote', '!'],
    ],
  ];
  for (const [name, files, words] of fixtures) {
    const { r } = based(`${declaration}inputs:\n  source: [src/**]\ninclude: proof.d/*.yaml\n`);
    r.write('proof.d/web.yaml', 'tasks: {}');
    const b = r.commit(files);
    const result = r.check([item(name, b, b)]);
    expect(result.code).toBe(2);
    for (const word of words) expect(result.err).toContain(word);
  }
});

test('rejects malformed case documents rather than accepting an empty check', () => {
  const { r, a } = based();
  for (const cases of [[], {}, [item('valid', a, a), { ...item('bad', a, a), typo: true }]]) {
    const result = r.check(cases);
    expect(result.code).toBe(2);
    expect(result.err).toContain('cases');
  }
});

test('a submodule pointer bump re-runs the task whose glob covers it', () => {
  const r = repo();
  const yaml =
    'version: 1\nproject: fixture\ntasks:\n  v:\n    run: exit 99\n    inputs: [vendor/**]\n';
  r.commit({ 'proof.yaml': yaml, 'vendor/README': 'r' });
  const pin = (oid: string) => {
    r.git('update-index', '--add', '--cacheinfo', `160000,${oid},vendor/sub`);
    r.git('commit', '-qm', 'pin');
    return r.git('rev-parse', 'HEAD');
  };
  const a = pin('1'.repeat(40));
  const b = pin('2'.repeat(40));
  const result = r.check([item('bump', a, b, ['v'])]);
  expect(result.out).toContain('PASS bump');
  expect(result.code).toBe(0);
});

test('glob boundaries preserve exact selections beside neighboring paths', () => {
  const r = repo();
  const patterns = {
    literal: ['src/a.ts'],
    directory: ['src/**'],
    wildcard: ['**/b.ts'],
    braces: ['src/{a,b}.ts'],
    classes: ['src/[ab].ts'],
    extglob: ['src/@(a|b).ts'],
    doubleNegative: ['src/**', '!!src/private/**'],
    escaped: ['src/\\[literal\\].ts'],
  };
  const a = r.commit({
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'fixture',
      tasks: Object.fromEntries(
        Object.entries(patterns).map(([id, inputs]) => [id, { run: 'exit 99', inputs }]),
      ),
    }),
    'src/a.ts': 'a',
    'src/a.tsx': 'neighbor',
    'src/b.ts': 'b',
    'src-neighbor/a.ts': 'neighbor',
    'src/private/a.ts': 'private',
    'src/[literal].ts': 'escaped',
  });
  const edits: [string, string[]][] = [
    ['src/a.ts', ['literal', 'directory', 'braces', 'classes', 'extglob']],
    ['src/a.tsx', ['directory']],
    ['src/b.ts', ['directory', 'wildcard', 'braces', 'classes', 'extglob']],
    ['src-neighbor/a.ts', []],
    ['src/private/a.ts', ['directory', 'doubleNegative']],
    ['src/[literal].ts', ['directory', 'escaped']],
  ];
  const cases = edits.flatMap(([path, expected]) => {
    r.git('reset', '--hard', a);
    const b = r.commit({ [path]: 'changed' });
    return [item(path, a, b, expected), item(`${path} reverse`, b, a, expected)];
  });
  const result = r.check(cases);
  expect(result).toEqual({
    code: 0,
    err: '',
    out: cases.map((c) => `PASS ${c.name}\n`).join(''),
  });
});

test('a duplicate key in the cases file fails loudly', () => {
  const { r, a } = based();
  for (const newline of ['\n', '\r\n', '\r']) {
    r.write(
      '.git/cases.yaml',
      `- name: dup\n  from: ${a}\n  to: ${a}\n  expect: [lint]\n  expect: []\n`.replaceAll(
        '\n',
        newline,
      ),
    );
    const result = r.cli(['check', '.git/cases.yaml']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('.git/cases.yaml');
    expect(result.err).toContain("line 5: duplicate key 'expect'");
  }
});

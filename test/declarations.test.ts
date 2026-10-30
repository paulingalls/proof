import { afterEach, expect, test } from 'bun:test';
import { Repo } from './support/repo';

let repo: Repo;
afterEach(() => repo?.close());
const header = 'version: 1\nproject: fixture\n';
const task = '{run: echo ok, inputs: [src/**]}';
const lint = `tasks:\n  lint: ${task}\n`;
function commit(source: string, included = '') {
  return repo.commit({
    'proof.yaml': source,
    'proof.d/web.yaml': included,
    'src/a.ts': 'a',
  });
}
function plan(json = false) {
  return repo.cli(['plan', ...(json ? ['--json'] : [])], {
    PROOF_STATE_DIR: `${repo.path}/.git/state`,
  });
}
function commands(ref: string) {
  const env = { PROOF_STATE_DIR: `${repo.path}/.git/state` };
  return [
    repo.check([{ name: 'same', from: ref, to: ref, expect: [] }]),
    repo.cli(['plan', '--json'], env),
    repo.cli(['record', 'lint', '--outcome', 'green'], env),
  ];
}

test('refuses duplicate declarations through check, plan and record', () => {
  repo = new Repo();
  const fixtures: [string, string, number][] = [
    [`tasks: {}\n${lint}`, 'tasks', 4],
    [`tasks:\n  lint: ${task}\n  lint: ${task}`, 'lint', 5],
    [`inputs:\n  source: [src/**]\n  source: [src/**]\n${lint}`, 'source', 5],
  ];
  for (const [body, key, line] of fixtures) {
    const ref = commit(header + body);
    for (const result of commands(ref)) {
      expect(result.code).toBe(2);
      expect(result.err).toContain('proof.yaml');
      expect(result.err).toContain(`line ${line}: duplicate key '${key}'`);
    }
  }
});

test('refuses CR-separated duplicate tasks and coverage at the CLI boundary', () => {
  repo = new Repo();
  for (const [body, key, line] of [
    [`tasks: {lint: ${task}}\ntasks: {}\ncoverage: [scripts/**]\ncoverage: []`, 'tasks', 4],
    [`${lint}coverage: [scripts/**]\ncoverage: []`, 'coverage', 6],
  ] as const) {
    const ref = repo.commit({
      'proof.yaml': `${header}${body}\n`.replaceAll('\n', '\r'),
      'src/a.ts': 'a',
      'scripts/verify.sh': 'echo ok',
    });
    for (const result of [...commands(ref), repo.cli(['lint'])]) {
      expect(result.code).toBe(2);
      expect(result.err).toContain('proof.yaml');
      expect(result.err).toContain(`line ${line}: duplicate key '${key}'`);
    }
  }
});

test('decodes keys and tracks mapping boundaries in accepted YAML and JSON', () => {
  repo = new Repo();
  const fixtures: [string, string, number][] = [
    [`tasks:\n  lint:\n    run: echo first\n    run: echo second\n    inputs: [src/**]`, 'run', 6],
    ...['"lint"', "'lint'", '"l\\u0069nt"', '"l\\x69nt"', '!!str lint', '&k lint'].map(
      (key): [string, string, number] => [`tasks:\n  lint: ${task}\n  ${key}: ${task}`, 'lint', 5],
    ),
    [`inputs:\n  "it's": [src/**]\n  'it''s': [src/**]\n${lint}`, "it's", 5],
    [`tasks: {lint: ${task},\n lint: ${task}}`, 'lint', 4],
    [`tasks: {lint, lint: ${task}}`, 'lint', 3],
    [`tasks:\n  ? lint\n  : ${task}\n  ? lint\n  : ${task}`, 'lint', 6],
    [
      `tasks:\n  lint:\n    run: |\n      tasks: tasks: {run: x}\n    inputs:\n    - src/**\n  lint: ${task}`,
      'lint',
      9,
    ],
    [
      `tasks:\n  lint:\n    run: >\n      tasks: tasks: {run: x}\n    inputs:\n      - src/**\n  lint: ${task}`,
      'lint',
      9,
    ],
    [
      `tasks:\n  lint:\n    inputs:\n      - >\n        src/**\n      - src/a\n        b\n    run: x\ntasks: {}`,
      'tasks',
      11,
    ],
    [`tasks:\n  lint: ${task}\n  1: ${task}\n  0x1: ${task}`, '1', 6],
    [`inputs:\n  ~: [src/**]\n  : [src/**]\n${lint}`, 'null', 5],
  ];
  for (const [body, key, line] of fixtures) {
    commit(header + body);
    const result = plan();
    expect(result.code).toBe(2);
    expect(result.err).toContain('proof.yaml');
    expect(result.err).toContain(`line ${line}: duplicate key '${key}'`);
  }
  for (const [source, line] of [
    [
      `{"version":1,"project":"fixture","tasks":{"lint":{"run":"echo ok","inputs":["src/**"]},"l\\u0069nt":{"run":"echo ok","inputs":["src/**"]}}}`,
      1,
    ],
    [`\uFEFF${header}tasks: {}\ntasks: {lint: ${task}}`, 4],
    [`${header}tasks: {}\ntasks: {lint: ${task}}`.replaceAll('\n', '\r\n'), 4],
  ] as const) {
    commit(source);
    const result = plan();
    expect(result.code).toBe(2);
    expect(result.err).toContain(`line ${line}: duplicate key '${line === 1 ? 'lint' : 'tasks'}'`);
  }
}, 15_000);

test('reports included file positions and refuses keys needing external context', () => {
  repo = new Repo();
  commit(`${header}${lint}include: proof.d/*.yaml`, `tasks:\n  web: ${task}\n  web: ${task}`);
  const included = plan();
  expect(included.code).toBe(2);
  expect(included.err).toContain("proof.d/web.yaml: Error: line 3: duplicate key 'web'");
  for (const body of [
    `inputs:\n  &k source: [src/**]\n  *k : [src/**]\n${lint}`,
    `inputs:\n  [source]: [src/**]\n${lint}`,
    `inputs:\n  ? {source: x}\n  : [src/**]\n${lint}`,
    `inputs:\n  ?\n    [source]\n  : [src/**]\n${lint}`,
  ]) {
    commit(header + body);
    const result = plan();
    expect(result.code).toBe(2);
    expect(result.err).toContain('proof.yaml');
    expect(result.err).toContain(
      `line ${body.includes('*k') || body.includes('?\n') ? 5 : 4}: unsupported key`,
    );
  }
});

test('preserves sibling mappings, sequences and scalar text', () => {
  repo = new Repo();
  const fixtures: [string, string[]][] = [
    [`${lint}  other: ${task}`, ['lint', 'other']],
    [`inputs:\n  inputs: [src/**]\ntasks:\n  tasks: ${task}\n  lint: ${task}`, ['lint', 'tasks']],
    [`tasks: {lint: ${task}, other: ${task}}\ninputs: {source: [src/**]}`, ['lint', 'other']],
    ...['    - src/**', '      - src/**'].map((sequence): [string, string[]] => [
      `tasks:\n  lint:\n    run: echo ok\n    inputs:\n${sequence}\n  other: ${task}`,
      ['lint', 'other'],
    ]),
    ...['|', '>-', '"tasks: run: {a,b} # tasks: run:"', "'tasks: run: {a,b} # tasks:'"].map(
      (value): [string, string[]] => [
        `tasks:\n  lint:\n    run: ${value}\n${value.length < 3 ? '      tasks: run: {a,b} # tasks: run:\n' : ''}    inputs: [src/**]\n  other: ${task}`,
        ['lint', 'other'],
      ],
    ),
    [
      `# tasks: tasks:\ntasks:\n  lint:\n    run: echo https://example.invalid # run: run:\n    inputs: [src/**]`,
      ['lint'],
    ],
  ];
  for (const [index, [body, ids]] of fixtures.entries()) {
    const ref = commit(`%YAML 1.2\n---\n${header}${body}\n...\n`);
    const results = index === 0 ? commands(ref) : [plan(true)];
    for (const result of results) {
      expect(result.code).toBe(0);
      expect(result.err).toBe('');
    }
    const planned = results[index === 0 ? 1 : 0];
    expect(
      JSON.parse(planned?.out ?? '')
        .map((row: { task: string }) => row.task)
        .sort(),
    ).toEqual(ids);
    if (index === 0) {
      expect(results[0]?.out).toContain('PASS same');
      expect(results[2]?.out).toContain('proof published');
    }
  }
});

test('quotes within plain keys are literal characters', () => {
  repo = new Repo();
  for (const key of ["it's", 'a"b']) {
    commit(`${header}tasks:\n  ${key}: ${task}\n  ${key}: ${task}`);
    const result = plan();
    expect(result.code).toBe(2);
    expect(result.err).toContain(`line 5: duplicate key '${key}'`);
  }
});

test('root node properties cannot hide mapping keys', () => {
  repo = new Repo();
  for (const [source, line] of [
    [`&root\n${header}tasks: {}\n${lint}`, 5],
    [`&root {version: 1, project: fixture, tasks: {}, tasks: {lint: ${task}}}`, 1],
    [`&root version: 1\nproject: fixture\ntasks: {}\n${lint}`, 4],
  ] as const) {
    commit(source);
    const result = plan();
    expect(result.code).toBe(2);
    expect(result.err).toContain(`line ${line}: duplicate key 'tasks'`);
  }
});

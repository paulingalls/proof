import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, task } from './support/jobs';

const artifacts = { artifacts: ['test-results/**', 'debug/**'] };

test('included artifacts declarations preserve keys and requirement-suite decisions', () => {
  const f = fixture({});
  f.repo.commit({
    'proof.yaml': 'version: 1\nproject: jobs\ninclude: tasks.yaml\n',
    'tasks.yaml': 'tasks: {a: {run: cat input, inputs: [input]}}',
  });
  let key: string | undefined;
  let from = f.repo.git('rev-parse', 'HEAD');
  for (const extra of [{}, artifacts, { artifacts: ['changed/**'] }, { artifacts: [] }, {}]) {
    const to = f.repo.commit({
      'tasks.yaml': JSON.stringify({
        tasks: { a: { run: 'cat input', inputs: ['input'], ...extra } },
      }),
    });
    const result = f.repo.cli(['plan', '--json'], f.env);
    expect(result.code, result.err).toBe(0);
    const actual = JSON.parse(result.out)[0].key;
    expect(actual).toBeString();
    expect(actual).not.toBe('');
    key ??= actual;
    expect(actual).toBe(key);
    f.repo.write(
      '.git/cases.yaml',
      JSON.stringify([{ name: 'artifact edit', from, to, expect: [] }]),
    );
    const checked = f.repo.cli(['check', '.git/cases.yaml'], f.env);
    expect(checked.code, checked.out + checked.err).toBe(0);
    from = to;
  }
});

for (const [value, message] of [
  ['bad', 'expected a list'],
  [[''], 'expected a nonempty string'],
  [['!debug/**'], 'negation'],
  [['/debug/**'], 'sandbox-relative'],
  [['debug/../trace.zip'], 'sandbox-relative'],
] as [unknown, string][]) {
  test(`artifacts rejects ${JSON.stringify(value)}`, () => {
    const f = fixture(
      {},
      {},
      {
        'proof.yaml': JSON.stringify({
          version: 1,
          project: 'jobs',
          tasks: { a: { ...task('false'), artifacts: value } },
        }),
      },
    );
    const result = f.repo.cli(['plan'], f.env);
    expect(result.code).toBe(2);
    for (const word of ["task 'a'", 'artifacts', message]) expect(result.err).toContain(word);
  });
}

test('red captures final binary and nested diagnostics; green and unmatched leave no artifacts', () => {
  const f = fixture({
    red: {
      run: `mkdir -p test-results/nested debug; printf '\\000\\377\\001' > test-results/nested/trace.zip; echo before > debug/error-context.md; echo after > debug/error-context.md; false`,
      inputs: ['input'],
      ...artifacts,
    },
    green: { run: 'mkdir debug; echo green > debug/context', inputs: ['input'], ...artifacts },
    unmatched: { run: 'false', inputs: ['input'], ...artifacts },
  });
  const result = f.run('--jobs', '2');
  expect(result.code, result.err).toBe(1);
  const directory = join(f.env.PROOF_STATE_DIR, 'logs/jobs/tasks');
  const log = readdirSync(join(directory, 'red')).find((name) => name.endsWith('.log')) as string;
  const path = join(directory, 'red', log);
  const stem = path.slice(0, -4);
  expect(result.out).toContain(`; log: ${path}; artifacts: ${stem}\n`);
  expect(readFileSync(join(stem, 'test-results/nested/trace.zip'))).toEqual(
    Buffer.from([0, 255, 1]),
  );
  expect(readFileSync(join(stem, 'debug/error-context.md'), 'utf8')).toBe('after\n');
  expect(existsSync(join(directory, 'green'))).toBe(false);
  expect(readdirSync(join(directory, 'unmatched'))).toHaveLength(1);
  expect(result.out.split('\n').find((line) => line.startsWith('red unmatched;'))).not.toContain(
    'artifacts:',
  );
  expect(
    f
      .rows()
      .map((row) => [row.task, row.outcome])
      .sort(),
  ).toEqual([
    ['green', 'green'],
    ['red', 'red'],
    ['unmatched', 'red'],
  ]);
});

test('artifact copy failure reports exit 2 and preserves the recorded red', () => {
  const f = fixture({
    a: {
      run: 'echo private > diagnostic; chmod 000 diagnostic; false',
      inputs: ['input'],
      ...{ artifacts: ['diagnostic'] },
    },
  });
  const result = f.run();
  expect(result.code, result.out + result.err).toBe(2);
  expect(result.out).toMatch(/red a; log failed: .*EACCES/);
  expect(result.out).toContain('diagnostic');
  const directory = join(f.env.PROOF_STATE_DIR, 'logs/jobs/tasks/a');
  const log = readdirSync(directory).find((name) => name.endsWith('.log')) as string;
  expect(result.out).toContain(join(directory, log.slice(0, -4)));
  expect(f.rows().map((row) => row.outcome)).toEqual(['red']);
});

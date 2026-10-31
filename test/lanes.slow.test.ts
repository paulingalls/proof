import { expect, test } from 'bun:test';
import { fixture, task } from './support/jobs';

const declaration = (tasks: unknown, extra = {}) =>
  JSON.stringify({ version: 1, project: 'jobs', tasks, ...extra });

test('lane declaration errors reach every declaration reader', () => {
  const f = fixture({ t: task('true') });
  for (const [extra, lane, message, all] of [
    [{}, 'missing', "unknown lane 'missing'", true],
    [{ lanes: { solo: 1 } }, undefined, "lane 'solo': reserved", true],
    [{ lanes: { ios: 0 } }, undefined, "lane 'ios': expected a positive safe integer", true],
    ...[-1, 1.5, '2', null, 9007199254740992].map((limit) => [
      { lanes: { ios: limit } },
      undefined,
      "lane 'ios': expected a positive safe integer",
      false,
    ]),
    [{ lanes: [] }, undefined, 'lanes: expected a mapping', false],
    [{ lanes: null }, undefined, 'lanes: expected a mapping', false],
    [{}, '', 'lane: expected a nonempty string', false],
  ] as const) {
    f.repo.commit({ 'proof.yaml': declaration({ t: { ...task('true'), lane } }, extra) });
    f.repo.write('.git/cases.yaml', '[{"name":"same","from":"HEAD","to":"HEAD","expect":[]}]');
    for (const command of all
      ? [
          'plan',
          'run',
          'record t --outcome green',
          'why t',
          'status --ref HEAD',
          'lint',
          'doctor',
          'check .git/cases.yaml',
        ]
      : ['lint']) {
      const result = f.repo.cli(command.split(' '), f.env);
      expect(result.code, command + result.err).toBe(2);
      expect(result.err).toContain(message as string);
    }
  }
  f.repo.commit({
    'proof.yaml': declaration({}, { include: 'proof.d/*.yaml' }),
    'proof.d/tasks.yaml': JSON.stringify({ tasks: { t: { ...task('true'), lane: 'missing' } } }),
  });
  expect(f.repo.cli(['lint'], f.env).err).toContain("task 't': unknown lane 'missing'");
}, 30000);

test('included lanes and solo parse; scheduling metadata preserves existing proof', () => {
  const f = fixture({ t: task('true') });
  expect(f.repo.cli(['record', 't', '--outcome', 'green'], f.env).code).toBe(0);
  for (const [lane, lanes] of [
    ['ios', { ios: 2 }],
    ['solo', {}],
    ['ios', { ios: 1 }],
  ] as const) {
    f.repo.commit({
      'proof.yaml': declaration({}, { lanes, include: 'proof.d/*.yaml' }),
      'proof.d/tasks.yaml': JSON.stringify({ tasks: { t: { ...task('true'), lane } } }),
    });
    const result = f.repo.cli(['plan', '--json'], f.env);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject([{ task: 't', state: 'PROVEN' }]);
  }
  f.repo.commit({ 'proof.yaml': declaration({ t: { ...task('true'), lane: 'solo' } }) });
  expect(f.run().code).toBe(0);
});

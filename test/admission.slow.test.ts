import { expect, test } from 'bun:test';
import { fixture, task } from './support/jobs';

test('admission uses frozen plan medians and recomputes pending lane pressure', () => {
  const cases: {
    ids: string[];
    seconds: Record<string, number | number[]>;
    expected: string[];
    ios?: number;
    jobs?: number;
  }[] = [
    { ids: ['x', 'y', 'z'], seconds: { x: [1, 1, 9], y: 5, z: 3 }, expected: ['y', 'z', 'x'] },
    {
      ids: ['i1', 'i2', 'u1', 'u2', 'u3'],
      seconds: { i1: 10, i2: 10, u1: 6, u2: 6, u3: 6 },
      expected: ['i1', 'u1', 'u2', 'i2', 'u3'],
      ios: 1,
    },
    {
      ids: ['i1', 'i2', 'u1'],
      seconds: { i1: 10, i2: 10, u1: 15 },
      expected: ['u1', 'i1', 'i2'],
      ios: 2,
    },
    {
      ids: ['i1', 'u1', 'u2', 'u3'],
      seconds: { i1: 10, u1: 9, u2: 9, u3: 9 },
      expected: ['i1', 'u1'],
      ios: 1,
      jobs: 2,
    },
    { ids: ['p', 'r', 'q'], seconds: { p: 1, r: 4 }, expected: ['r', 'q', 'p'] },
    { ids: ['q', 'r', 'p'], seconds: { p: 1, r: 4 }, expected: ['q', 'r', 'p'] },
    { ids: ['z', 'x', 'y'], seconds: {}, expected: ['z', 'x', 'y'] },
  ];
  for (const { ids, seconds, expected, ios, jobs = 1 } of cases) {
    const tasks = Object.fromEntries(
      ids.map((id) => [
        id,
        {
          ...task(`echo ${id} >> scratch/starts`),
          lane: ios && id.startsWith('i') ? 'ios' : undefined,
        },
      ]),
    );
    const f = fixture(tasks);
    if (ios)
      f.repo.commit({
        'proof.yaml': JSON.stringify({ version: 1, project: 'jobs', lanes: { ios }, tasks }),
      });
    for (const [id, value] of Object.entries(seconds)) {
      for (const sample of Array.isArray(value) ? value : [value]) {
        const recorded = f.repo.cli(
          ['record', id, '--outcome', 'green', '--seconds', String(sample)],
          f.env,
        );
        expect(recorded.code, recorded.err).toBe(0);
      }
    }
    const result = f.run(
      '--jobs',
      String(jobs),
      ...(Object.keys(seconds).length ? ['--fresh'] : []),
    );
    expect(result.code, result.out + result.err).toBe(0);
    const starts = f.read('starts').trim().split('\n');
    // With jobs > 1 the first admissions start together; only their set is ordered.
    expect(jobs === 1 ? starts : starts.slice(0, jobs).sort(), ids.join(',')).toEqual(expected);
    expect(
      result.out
        .split('\n')
        .filter((line) => line.startsWith('RUN '))
        .map((line) => line.split(':')[0]),
    ).toEqual(ids.map((id) => `RUN ${id}`));
  }
});

import { expect, test } from 'bun:test';
import { fixture, task } from './support/jobs';

test('default and explicit jobs=1 preserve the serial transcript', () => {
  const f = fixture({
    a: task('echo a-out; echo a-err >&2; exit 1'),
    b: task('echo b-out; echo b-err >&2'),
  });
  const expected = {
    code: 1,
    out: 'RUN a: no proof for key; trusted links: scratch\nRUN b: no proof for key; trusted links: scratch\na-out\nb-out\nred a\ngreen b; proof published\n',
    err: 'a-err\nb-err\n',
  };
  const first = f.run();
  expect(first).toEqual(expected);
  expect(f.repo.cli(['run', '--jobs', '1'], { ...f.env, PROOF_STATE_DIR: f.directory() })).toEqual(
    expected,
  );
});

test('jobs requires one positive safe integer before the selector', () => {
  const f = fixture({ a: task('true') });
  for (const args of [
    ['--jobs', '0'],
    ['--jobs', 'x'],
    ['--jobs'],
    ['--jobs', '-1'],
    ['--jobs', '1.5'],
    ['--jobs', '9007199254740992'],
    ['--jobs', '1', '--jobs', '2'],
    ['--tasks', 'a', '--jobs', '2'],
  ]) {
    const result = f.run(...args);
    expect(result.code).toBe(2);
    expect(result.err).toContain(
      'usage: proof run [--fresh | --staged] [--jobs N] [--tasks <id> ... | --set <name>]',
    );
  }
  expect(f.run('--jobs', '2').code).toBe(0);
});

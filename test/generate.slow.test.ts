import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Repo } from './support/repo';

let r: Repo;
afterEach(() => r?.close());
const output = `inputs:\n  generated: [source]\ntasks:\n  generated:\n    run: cat source\n    inputs: [$generated]\n`;
const root = `version: 1\nproject: generated-tests\ninclude: committed/*.yaml\ngenerate:\n  run: sh generator.sh\n  inputs: [generator.sh, declarations]\n`;
function fixture() {
  r = new Repo();
  r.commit({
    'proof.yaml': root,
    'committed/base.yaml': 'tasks:\n  base: {run: cat source, inputs: [source]}\n',
    'generator.sh':
      'echo stdout; echo stderr >&2; mkdir "$PROOF_DECLARATIONS/nested"; cp declarations "$PROOF_DECLARATIONS/nested/tasks.yaml"\n',
    declarations: output,
    source: 'hello\n',
    '.gitignore': 'proof.d/\n',
  });
  return { PROOF_STATE_DIR: join(r.path, '.git/state') };
}
function rows(env: Record<string, string>) {
  const result = r.cli(['plan', '--json'], env);
  expect(result.code, result.err).toBe(0);
  return JSON.parse(result.out);
}

test('generated nested declarations coexist with includes and keep committed keys', () => {
  const env = fixture();
  r.write('proof.d/decoy.yaml', 'tasks: {decoy: {run: false, inputs: [missing]}}');
  const generated = rows(env);
  expect(generated.map((row: { task: string }) => row.task)).toEqual(['base', 'generated']);
  expect(existsSync(join(r.path, 'nested/tasks.yaml'))).toBe(false);
  r.commit({
    'proof.yaml': root.replace(/generate:[\s\S]*/, ''),
    'committed/generated.yaml': output,
  });
  expect(rows(env).map((row: { key: string }) => row.key)).toEqual(
    generated.map((row: { key: string }) => row.key),
  );
});

test('historical refs use their own generator and leave checkout and index untouched', () => {
  const env = fixture();
  const a = r.git('rev-parse', 'HEAD');
  const before = rows(env);
  r.commit({ declarations: output.replaceAll('generated', 'later') });
  r.write('generator.sh', 'exit 99');
  r.write('declarations', 'invalid');
  const state = r.git('status', '--porcelain');
  const index = r.git('write-tree');
  const result = r.cli(['status', '--ref', a, '--json'], {
    PROOF_STATE_DIR: `${env.PROOF_STATE_DIR}-cold`,
  });
  expect(result.code, result.err).toBe(1);
  expect(
    JSON.parse(result.out).map((row: { task: string; key: string }) => [row.task, row.key]),
  ).toEqual(before.map((row: { task: string; key: string }) => [row.task, row.key]));
  expect(r.git('status', '--porcelain')).toBe(state);
  expect(r.git('write-tree')).toBe(index);
});

test('staged run and lint use index declarations despite unstaged generator edits', () => {
  const env = fixture();
  r.write('declarations', output.replaceAll('generated', 'staged'));
  r.git('add', 'declarations');
  r.write('generator.sh', 'exit 99');
  r.write('declarations', 'invalid');
  const result = r.cli(['run', '--staged'], env);
  expect(result.code, result.err).toBe(0);
  expect(result.out).toContain('staged');
  expect(r.cli(['lint'], env).code).toBe(0);
  r.git('commit', '-qm', 'index');
  expect(r.cli(['status', '--ref', 'HEAD'], env).code).toBe(0);
});

test('generated unkeyed and coverage declarations participate in lint and check', () => {
  const env = fixture();
  const declarations = `tasks:\n  reader: {run: cat source, inputs: [source]}\n  owner: {run: cat source, inputs: [source], keyed: [source]}\nunkeyed: [source]\n`;
  const a = r.commit({ 'proof.yaml': `${root}coverage: [source]\n`, declarations });
  expect(r.cli(['lint'], env).code).toBe(0);
  const b = r.commit({ source: 'changed\n' });
  r.write(
    '.git/cases.yaml',
    JSON.stringify([{ name: 'owner', from: a, to: b, expect: ['owner'] }]),
  );
  const checked = r.cli(['check', '.git/cases.yaml'], env);
  expect(checked.code, checked.out + checked.err).toBe(0);
  r.commit({ declarations: 'tasks: {}\n' });
  const missing = r.cli(['lint'], env);
  expect(missing.code).toBe(1);
  expect(missing.out + missing.err).toContain('source');
});

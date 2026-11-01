import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Repo } from './support/repo';

let r: Repo;
afterEach(() => r?.close());
const output = 'tasks:\n  gate: {run: cat source, inputs: [source]}\n';
const root =
  'version: 1\nproject: generator-refusals\ngenerate:\n  run: sh generator.sh\n  inputs: [generator.sh, data]\n';
function fixture() {
  r = new Repo();
  r.commit({
    'proof.yaml': root,
    'generator.sh': 'cp data "$PROOF_DECLARATIONS/tasks.yaml"',
    data: output,
    source: 'hello',
    '.gitignore': 'proof.d/\ninstalled/\n',
  });
  return { PROOF_STATE_DIR: join(r.path, '.git/state') };
}
function failed(result: ReturnType<Repo['cli']>, reason: string, log = true) {
  expect(result.code, result.out + result.err).toBe(2);
  expect(result.err).toContain('proof.yaml generate');
  expect(result.err).toContain(reason);
  if (log) {
    const path = result.err.match(/; log: (.+)/)?.[1] ?? '';
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain(reason);
  }
}

test('every declaration reader fails on a broken generator despite warm cache and ignored output', () => {
  const env = fixture();
  expect(r.cli(['record', 'gate', '--outcome', 'green'], env).code).toBe(0);
  r.commit({ 'generator.sh': 'echo broken >&2; exit 17' });
  r.write('proof.d/decoy.yaml', output);
  r.write(
    '.git/cases.yaml',
    JSON.stringify([{ name: 'same', from: 'HEAD', to: 'HEAD', expect: [] }]),
  );
  const commands = [
    ['plan'],
    ['run'],
    ['run', '--staged'],
    ['status', '--ref', 'HEAD'],
    ['why', 'gate'],
    ['lint'],
    ['check', '.git/cases.yaml'],
    ['doctor'],
    ['stats'],
    ['record', 'gate', '--outcome', 'green'],
    ['flakes'],
    ['invalidate', '--task', 'gate', '--all'],
  ];
  for (const args of commands) failed(r.cli(args, env), 'exited 17');
  r.commit({ 'generator.sh': 'cp data "$PROOF_DECLARATIONS/tasks.yaml"' });
  expect(r.cli(['status', '--ref', 'HEAD'], env).code).toBe(0);
});

test('generator rejects missing inputs, undeclared reads and unsafe or invalid output', () => {
  const env = fixture();
  for (const [files, reason, log] of [
    [{ 'generator.sh': 'cat source > "$PROOF_DECLARATIONS/tasks.yaml"' }, 'exited 1', true],
    [
      { 'proof.yaml': root.replace('generator.sh, data', 'generator.sh, absent') },
      'missing input',
      true,
    ],
    [
      { 'proof.yaml': root.replace('generator.sh, data', 'generator.sh, absent/*') },
      'unmatched input',
      true,
    ],
    [
      {
        'proof.yaml': root.replace('generator.sh, data', 'generator.sh, {path: absent, json: [x]}'),
      },
      'missing input',
      true,
    ],
    [{ data: 'tasks: [\n' }, 'YAML', true],
    [{ data: 'tasks: {}\ntasks: {}\n' }, 'duplicate', true],
    [{ data: `${output}unkeyed: [source]\n` }, 'representative', false],
    [{ 'generator.sh': 'true' }, 'no *.yaml output', true],
    [{ 'generator.sh': 'ln -s data "$PROOF_DECLARATIONS/tasks.yaml"' }, 'symlink', true],
    [
      { 'proof.yaml': `${root}tasks:\n  gate: {run: "true", inputs: [source]}\n` },
      'duplicate task',
      false,
    ],
    [
      { data: 'inputs: {same: [source]}\n', 'proof.yaml': `${root}inputs: {same: [source]}\n` },
      'duplicate input set',
      false,
    ],
    [
      {
        'proof.yaml':
          root.replace('generator.sh, data', 'generator.sh, $ignored') +
          'inputs: {ignored: [{dotenv: ignored}]}\n',
      },
      'dotenv',
      true,
    ],
  ] as [Record<string, string>, string, boolean][]) {
    r.git('reset', '--hard', 'HEAD');
    r.commit({ ...files });
    failed(r.cli(['plan'], env), reason, log);
    r.git('reset', '--hard', 'HEAD~1');
  }
});

test('explicit installed links work and escaping links fail', () => {
  const env = fixture();
  r.write('installed/tasks.yaml', output);
  r.commit({
    'proof.yaml': `${root}  links: [installed]\n`,
    'generator.sh': 'cp installed/tasks.yaml "$PROOF_DECLARATIONS/tasks.yaml"',
  });
  expect(r.cli(['plan'], env).code).toBe(0);
  symlinkSync(join(r.path, 'source'), join(r.path, 'installed/escape'));
  r.commit({ data: `${output}\n` });
  failed(r.cli(['plan'], env), 'link escape');
});

test('dirty generator output controls declarations and prevents publishing or contesting proof', () => {
  const env = fixture();
  const marker = join(r.path, '.git/invocations');
  r.commit({
    'generator.sh': `echo ran >> '${marker}'; sed '/^#/d' data > "$PROOF_DECLARATIONS/tasks.yaml"`,
  });
  expect(r.cli(['record', 'gate', '--outcome', 'green'], env).out).toContain('proof published');
  r.write('data', `${output}# unchanged\n`);
  const same = r.cli(['plan'], env);
  expect(same.code, same.err).toBe(0);
  expect(same.out).toContain('PROVEN gate');
  expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(2);
  r.cli(['plan'], env);
  expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(2);
  expect(r.cli(['run', '--fresh'], env).out).toContain('no proof published');
  expect(r.cli(['record', 'gate', '--outcome', 'green'], env).out).toContain(
    'no proof published: dirty path',
  );
  r.write('data', output.replace('cat source', 'echo changed'));
  const changed = r.cli(['plan'], env);
  expect(changed.code, changed.err).toBe(0);
  expect(changed.out).toContain("dirty declaration 'proof.yaml generate: tasks.yaml'");
  expect(r.cli(['why', 'gate'], env).out).toContain('dirty declaration');
  expect(r.cli(['run'], env).out).toContain('not recorded: dirty declaration');
  expect(r.cli(['record', 'gate', '--outcome', 'green'], env).out).toContain(
    'no proof published: dirty declaration',
  );
  expect(r.cli(['record', 'gate', '--outcome', 'red'], env).out).toContain(
    'contests nothing: dirty declaration',
  );
  expect(r.cli(['status', '--ref', 'HEAD'], env).code).toBe(0);
});

test('untracked generator inputs are included and deleted literals fail despite warm cache', () => {
  const env = fixture();
  r.commit({
    'proof.yaml': root.replace('generator.sh, data', 'generator.sh, data, extra/*'),
    'extra/a': 'one',
    'generator.sh': 'cat data extra/* > "$PROOF_DECLARATIONS/tasks.yaml"',
  });
  r.commit({ 'extra/a': '# one\n' });
  expect(r.cli(['plan'], env).code).toBe(0);
  r.write('extra/new', '  new: {run: cat source, inputs: [source]}\n');
  const changed = r.cli(['plan'], env);
  expect(changed.code, changed.err).toBe(0);
  expect(changed.out).toContain('RUN new');
  r.git('reset', '--hard', 'HEAD');
  unlinkSync(join(r.path, 'data'));
  failed(r.cli(['plan'], env), 'missing input');
});

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const states: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const path of states.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const repo = new Repo();
  repos.push(repo);
  const state = mkdtempSync(join(tmpdir(), 'proof-publication-'));
  states.push(state);
  const env = { PROOF_STATE_DIR: state };
  return { repo, cli: (...args: string[]) => repo.cli(args, env) };
}
const task = (inputs: unknown[], run = 'true') => ({ inputs, run });
const doc = (tasks: unknown, extra = {}) =>
  JSON.stringify({ version: 1, project: 'publication', tasks, ...extra });

for (const restricted of [false, true]) {
  test(`exclusions isolate publication and warn once before execution; restricted=${restricted}`, () => {
    const { repo, cli } = fixture();
    repo.commit({
      'proof.yaml': doc({
        all: task(['src/**'], 'echo task-marker-all'),
        filtered: task(['src/**', '!src/dirty'], 'echo task-marker-filtered'),
      }),
      'src/dirty': 'original',
      'src/clean': 'clean',
    });
    repo.write('src/dirty', 'working');
    const result = cli('run', '--jobs', '2', ...(restricted ? ['--tasks', 'filtered'] : []));
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('green filtered; proof published');
    if (restricted) expect(result.out).not.toContain('warning:');
    else {
      expect(result.out).toContain("green all; no proof published: dirty input 'src/dirty'");
      expect(result.out.match(/warning:/g)).toHaveLength(1);
      expect(result.out).toContain("warning: 1 task cannot publish: dirty input 'src/dirty'");
      expect(result.out.indexOf('warning:')).toBeLessThan(result.out.indexOf('task-marker-'));
    }
    expect(cli('plan').out).toContain('PROVEN filtered');
    repo.git('restore', 'src/dirty');
    expect(cli('plan').out).toContain('RUN all: no proof for key');
  });
}

for (const mode of ['run', 'record']) {
  test(`${mode} refuses selected unkeyed dirt while publishing an unrelated control`, () => {
    const { repo, cli } = fixture();
    repo.commit({
      'proof.yaml': doc(
        {
          reader: task(['shared.ts']),
          representative: { ...task(['shared.ts']), keyed: ['shared.ts'] },
          control: task(['control']),
        },
        { unkeyed: ['shared.ts'] },
      ),
      'shared.ts': 'original',
      control: 'clean',
    });
    repo.write('shared.ts', 'working');
    const result =
      mode === 'run'
        ? cli('run', '--tasks', 'reader', 'control')
        : cli('record', 'reader', '--outcome', 'green');
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain("reader; no proof published: dirty input 'shared.ts'");
    const control = mode === 'run' ? result : cli('record', 'control', '--outcome', 'green');
    expect(control.out).toContain('control; proof published');
    expect(cli('plan').out).toContain('PROVEN control');
    repo.git('restore', 'shared.ts');
    expect(cli('plan').out).toContain('RUN reader: no proof for key');
  });
}

test('deleted committed import cannot publish when a working shadow resolves', () => {
  const { repo, cli } = fixture();
  repo.commit({
    'proof.yaml': doc({
      closure: task([{ 'imports-of': 'entry.ts' }], 'test -f x.js && test ! -e x.ts'),
    }),
    'entry.ts': "import './x';",
    'x.ts': 'export const x = 1;',
    'x.js': 'export const x = 2;',
  });
  rmSync(join(repo.path, 'x.ts'));
  const result = cli('run');
  expect(result.code, result.err).toBe(0);
  expect(result.out).toContain("green closure; no proof published: dirty input 'x.ts'");
  repo.git('restore', 'x.ts');
  expect(cli('plan').out).toContain('RUN closure: no proof for key');
});

for (const priorDirt of [false, true]) {
  test(`new selected dirt during execution blocks only its task; priorDirt=${priorDirt}`, () => {
    const { repo, cli } = fixture();
    repo.commit({
      'proof.yaml': doc({
        writer: task(['src/**'], `touch '${repo.path}/src/new'`),
        control: task(['control']),
      }),
      'src/original': 'original',
      control: 'clean',
    });
    if (priorDirt) repo.write('notes', 'unrelated');
    const result = cli('run');
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain("green writer; no proof published: dirty input 'src/new'");
    expect(result.out).toContain('green control; proof published');
    expect(result.out).not.toContain('warning:');
    rmSync(join(repo.path, 'src/new'));
    expect(cli('plan').out).toContain('RUN writer: no proof for key');
    expect(cli('plan').out).toContain('PROVEN control');
  });
}

test('an unselected declaration changed during execution blocks publication', () => {
  const { repo, cli } = fixture();
  repo.commit({
    'proof.yaml': doc(
      { writer: task(['input'], `echo >> '${repo.path}/proof.d/extra.yaml'`) },
      { include: 'proof.d/*.yaml' },
    ),
    'proof.d/extra.yaml': '{"tasks":{}}',
    input: 'clean',
  });
  const result = cli('run');
  expect(result.code, result.err).toBe(0);
  expect(result.out).toContain(
    "green writer; no proof published: dirty declaration 'proof.d/extra.yaml'",
  );
  repo.git('restore', '.');
  expect(cli('plan').out).toContain('RUN writer: no proof for key');
});

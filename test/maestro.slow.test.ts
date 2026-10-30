import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const states: string[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.close();
  for (const path of states.splice(0)) rmSync(path, { recursive: true, force: true });
});
const flow = (commands: string, config = '') => `appId: example\n${config}---\n${commands}\n`;
const task = (entry: string, run = 'true') => ({ run, inputs: [{ maestro: entry }] as unknown[] });
function fixture(
  tasks: Record<string, ReturnType<typeof task>> = { a: task('flows/a.yaml') },
  files = {},
  extra = {},
) {
  const doc = { version: 1, project: 'maestro', tasks, ...extra };
  const r = Repo.from(JSON.stringify([doc, files]), (r) => {
    r.commit({ 'proof.yaml': JSON.stringify(doc), 'flows/a.yaml': flow('- launchApp'), ...files });
  });
  repos.push(r);
  return r;
}
function state() {
  const path = mkdtempSync(join(tmpdir(), 'proof-maestro-'));
  states.push(path);
  return { PROOF_STATE_DIR: path };
}
function plan(r: Repo, env = state()) {
  const result = r.cli(['plan', '--json'], env);
  expect(result.code, result.err).toBe(0);
  return JSON.parse(result.out) as { task: string; state: string; reason: string }[];
}

test('nested containers, hooks, cycles and aliases select only reached flow and leaf bytes', () => {
  const commands = `- repeat:
    times: 2
    commands:
      - runScript: ../repeat.js
- retry:
    commands:
      - runScript: {file: ../retry.js}
- retry: {file: nested/retry.yaml}
- runFlow:
    commands:
      - addMedia: [../media.bin]
- runFlow:
    when: {true: false}
    commands:
      - runScript: ../conditional.js
- runScript: nested/cycle.yaml
- runFlow: {file: nested/cycle.yaml}
- repeat: &loop
    commands:
      - repeat: *loop`;
  const files: Record<string, string> = {
    'flows/a.yaml': flow(
      commands,
      'onFlowStart:\n  - runScript: ../start.js\nonFlowComplete:\n  - runScript: ../complete.js\n',
    ),
    'flows/nested/retry.yaml': flow('- runScript: ../../file.js'),
    'flows/nested/cycle.yaml': flow('- runFlow: ../a.yaml\n- addMedia: {files: [../../cycle.bin]}'),
    'media.bin': '',
    'cycle.bin': '',
  };
  for (const name of ['repeat', 'retry', 'conditional', 'start', 'complete', 'file'])
    files[`${name}.js`] = 'not: [valid YAML\nrunFlow: missing.yaml';
  const r = fixture(undefined, files);
  for (const path of ['media.bin', 'cycle.bin'])
    writeFileSync(join(r.path, path), Buffer.from([0, 255]));
  let from = r.commit({});
  const cases = [{ name: 'same', from, to: from, expect: [] as string[] }];
  for (const path of Object.keys(files)) {
    const to = r.commit({ [path]: `${files[path]}\n# changed\n` });
    cases.push({ name: path, from, to, expect: ['a'] });
    from = to;
  }
  r.write('flows/a.yaml', 'broken: [');
  const result = r.check(cases);
  expect(result.code, result.err + result.out).toBe(0);
  expect(result.out).toBe(cases.map(({ name }) => `PASS ${name}\n`).join(''));
}, 15000);

test('undecidable flows name references and still run without recording', () => {
  const cases = [
    ['variable', `- runFlow: \${FLOW_DIR}/x.yaml`, `\${FLOW_DIR}/x.yaml`],
    ['missing', '- runScript: absent.js', 'absent.js'],
    ['entry', '', 'flows/entry.yaml'],
    ['malformed', '- runFlow: bad.yaml', 'flows/bad.yaml'],
    ['escape', '- runFlow: ../../outside.yaml', '../../outside.yaml'],
    ['absolute', '- runFlow: /outside.yaml', '/outside.yaml'],
    ['git', '- runFlow: ../.git/config', '../.git/config'],
    ['link', '- runScript: link.js', 'link.js'],
    ['shape', '- runFlow: {when: {true: false}}', 'runFlow'],
    ['retry', '- retry: {maxRetries: 2}', 'retry'],
  ];
  const files = Object.fromEntries(
    cases
      .filter(([id]) => id !== 'entry')
      .map(([id, commands]) => [`flows/${id}.yaml`, flow(commands as string)]),
  );
  const tasks = Object.fromEntries(cases.map(([id]) => [id as string, task(`flows/${id}.yaml`)]));
  const r = fixture(tasks, { ...files, 'flows/bad.yaml': 'bad: [', 'leaf.js': 'bytes' });
  symlinkSync('../leaf.js', join(r.path, 'flows/link.js'));
  r.commit({});
  const env = state();
  const rows = plan(r, env);
  for (const [id, , reference] of cases) {
    const row = rows.find((row) => row.task === id);
    expect(row?.state).toBe('RUN');
    expect(row?.reason).toContain('undecidable');
    expect(row?.reason).toContain(reference as string);
    expect(row?.reason).toContain(`flows/${id === 'malformed' ? 'bad' : id}.yaml`);
  }
  const run = r.cli(['run'], env);
  expect(run.code, run.err + run.out).toBe(0);
  for (const [id] of cases) expect(run.out).toContain(`green ${id}; not recorded:`);
  const lint = r.cli(['lint']);
  expect(lint.code).toBe(1);
  expect(lint.out).toContain("task 'entry': missing input 'flows/entry.yaml'");
});

test('named closures own index-reachable files and respect ordered exclusions', () => {
  const a = task('flows/a.yaml');
  a.inputs = ['$journey'];
  const r = fixture(
    { a },
    { 'flows/a.yaml': flow('- runScript: ../leaf.js'), 'leaf.js': 'bytes' },
    {
      inputs: { journey: [{ maestro: 'flows/a.yaml' }] },
      coverage: ['leaf.js'],
    },
  );
  expect(r.cli(['lint']).code).toBe(0);
  r.write('flows/a.yaml', flow('- launchApp'));
  expect(r.cli(['lint']).code).toBe(0);
  r.git('add', 'flows/a.yaml');
  expect(r.cli(['lint']).out).toContain("unowned 'leaf.js'");
  r.git('restore', '--source=HEAD', '--staged', '--worktree', 'flows/a.yaml');
  expect(r.cli(['lint']).code).toBe(0);
  const doc = JSON.parse(r.git('show', 'HEAD:proof.yaml'));
  doc.tasks.a.inputs.push('!leaf.js');
  r.write('proof.yaml', JSON.stringify(doc));
  r.git('add', 'proof.yaml');
  expect(r.cli(['lint']).out).toContain("unowned 'leaf.js'");
  doc.tasks.a.inputs = [{ maestro: 'flows/a.yaml', unexpected: true }];
  r.write('proof.yaml', JSON.stringify(doc));
  expect(r.cli(['plan']).code).toBe(2);
});

test('sandbox reads working closure bytes and only clean runs publish', () => {
  const run = `test -s flows/a.yaml && test -s flows/sub.yaml &&
    grep -Eq '^(old|edited)$' leaf.js &&
    test "$(od -An -tx1 media.bin | tr -d ' \\n')" = 00ff01 &&
    if grep -q extra.js flows/a.yaml; then test "$(cat extra.js)" = extra; fi &&
    echo closure-ok`;
  const original = flow('- runFlow: sub.yaml');
  const r = fixture(
    { a: task('flows/a.yaml', run) },
    {
      'flows/a.yaml': original,
      'flows/sub.yaml': flow('- runScript: ../leaf.js\n- addMedia: [../media.bin]'),
      'leaf.js': 'old',
      'media.bin': '',
      'extra.js': 'extra',
    },
  );
  writeFileSync(join(r.path, 'media.bin'), Buffer.from([0, 255, 1]));
  r.commit({});
  const env = state();
  const execute = (publication: string) => {
    const result = r.cli(['run', '--tasks', 'a'], env);
    expect(result.code, result.err + result.out).toBe(0);
    expect(result.out).toContain('closure-ok');
    expect(result.out).toContain(publication);
  };
  execute('proof published');
  expect(plan(r, env)[0]?.state).toBe('PROVEN');
  for (const staged of [false, true]) {
    r.write('leaf.js', 'edited');
    if (staged) r.git('add', 'leaf.js');
    expect(plan(r, env)[0]?.reason).toContain("dirty input 'leaf.js'");
    execute('no proof published');
    r.git('restore', '--source=HEAD', '--staged', '--worktree', 'leaf.js');
    expect(plan(r, env)[0]?.state).toBe('PROVEN');
  }
  r.write('flows/a.yaml', flow('- runFlow: sub.yaml\n- runScript: ../extra.js'));
  expect(plan(r, env)[0]?.reason).toContain("dirty input 'flows/a.yaml'");
  execute('no proof published');
  r.commit({});
  expect(plan(r, env)[0]?.state).toBe('RUN');
  execute('proof published');
  expect(plan(r, env)[0]?.state).toBe('PROVEN');
  expect(r.cli(['lint']).code).toBe(0);
});

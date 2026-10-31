import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const states: string[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.close();
  for (const path of states.splice(0)) rmSync(path, { recursive: true, force: true });
});
const task = (inputs: unknown[], keyed?: string[]) => ({ run: 'true', inputs, keyed });
const imports = { 'imports-of': 'entry.ts' };
const flow = { maestro: 'flows/main.yaml' };
const config = { path: 'config.json', json: ['name'] };
const reader = (input: unknown) => ({
  ...task([input]),
  run: `printf '%s' "$EXPECTED" | cmp - shared.ts`,
  env: ['EXPECTED'],
});
const declaration = (unkeyed: unknown, tasks: unknown) =>
  JSON.stringify({ version: 1, project: 'unkeyed', unkeyed, tasks });
function fixture() {
  const r = new Repo();
  repos.push(r);
  const doc = {
    version: 1,
    project: 'unkeyed',
    include: 'proof.d/*.yaml',
    unkeyed: ['shared.ts', 'flows/common.yaml', 'config.json'],
    tasks: {
      direct: reader('shared.ts'),
      closure: reader(imports),
      flow: task([flow]),
      control: task(['control']),
      representative: task([imports], ['shared.ts']),
      projection: task([config]),
      configRep: task([config], ['config.json']),
    },
  };
  r.commit({
    'proof.yaml': JSON.stringify(doc),
    'proof.d/tasks.yaml': JSON.stringify({
      tasks: { flowRep: task([flow], ['flows/common.yaml']) },
    }),
    'entry.ts': "import './shared';",
    'shared.ts': "import './leaf';",
    'leaf.ts': 'export {};',
    'flows/main.yaml': 'appId: x\n---\n- runFlow: common.yaml\n',
    'flows/common.yaml': 'appId: x\n---\n- runFlow: leaf.yaml\n',
    'flows/leaf.yaml': 'appId: x\n---\n- tapOn: Hello\n',
    'config.json': '{"name":"a"}',
    control: 'ok',
  });
  const state = mkdtempSync(join(tmpdir(), 'proof-unkeyed-'));
  states.push(state);
  const raw = (args: string[], EXPECTED = "import './leaf';") =>
    r.cli(args, { PROOF_STATE_DIR: state, EXPECTED });
  const cli = (args: string[], EXPECTED = "import './leaf';") => {
    const result = raw(args, EXPECTED);
    expect(result.code, result.err + result.out).toBe(0);
    return result.out;
  };
  return { r, doc, cli, raw };
}
test('unkeyed declarations validate all files and representatives before task selection', () => {
  const { r, doc, cli, raw } = fixture();
  cli(['plan']);
  for (const [unkeyed, keyed, name] of [
    [['orphan'], undefined, 'orphan'],
    [[], ['control'], 'control'],
  ] as const) {
    const head = r.git('rev-parse', 'HEAD');
    r.commit({
      'proof.yaml': JSON.stringify({ ...doc, unkeyed, tasks: { control: task(['control']) } }),
      orphan: 'x',
      'proof.d/tasks.yaml': JSON.stringify({
        tasks: { bad: task(['control'], keyed ? [...keyed] : undefined) },
      }),
    });
    r.write('.git/cases.yaml', '[{name: bad, from: HEAD, to: HEAD, expect: []}]');
    for (const command of [
      'plan',
      'run --tasks control',
      'record control --outcome green',
      'why control',
      'status --ref HEAD',
      'lint',
      'doctor',
      'stats',
      'flakes',
      'invalidate --task control',
      'check .git/cases.yaml',
    ]) {
      const result = raw(command.split(' '));
      expect(result.code, result.err + result.out).toBe(2);
      expect(result.err + result.out).toContain(name);
    }
    r.git('reset', '--hard', head);
  }
  for (const [unkeyed, keyed, inputs] of [
    [['*.ts'], ['shared.ts'], ['shared.ts']],
    [['shared.ts'], ['shared.ts'], ['control']],
    [['absent', 'shared.ts'], ['shared.ts'], ['shared.ts']],
    [['shared.ts'], ['absent', 'shared.ts'], ['shared.ts']],
    [['shared.ts'], ['*.ts'], ['shared.ts']],
    [['!shared.ts'], ['!shared.ts'], ['**']],
    ['shared.ts', [], ['shared.ts']],
    [[], 'shared.ts', ['shared.ts']],
  ]) {
    r.write('proof.yaml', declaration(unkeyed, { a: { run: 'true', inputs, keyed } }));
    expect(raw(['plan']).code).toBe(2);
  }
  r.write('new.ts', 'export {};');
  r.write(
    'proof.yaml',
    declaration(['*.ts'], {
      a: task(['*.ts'], ['entry.ts', 'shared.ts']),
      b: task(['*.ts'], ['leaf.ts', 'new.ts']),
    }),
  );
  cli(['plan']);
}, 30000);
test('unkeyed bytes stay in sandboxes while only representatives key them', () => {
  const { r, doc, cli } = fixture();
  expect(cli(['run'])).toContain('proof published');
  const from = r.git('rev-parse', 'HEAD');
  const changed = "import './leaf';\n";
  const to = r.commit({ 'shared.ts': changed });
  for (const id of ['direct', 'closure']) {
    expect(cli(['plan'])).toContain(`PROVEN ${id}`);
    expect(cli(['run', '--fresh', '--tasks', id], changed)).toContain(`green ${id}`);
  }
  expect(cli(['plan'])).toContain('RUN representative');
  const why = cli(['why', 'closure']);
  expect(why.match(/^unkeyed shared.ts$/gm)).toHaveLength(1);
  expect(why).not.toContain('changed file shared.ts');
  expect(cli(['why', 'representative'])).toContain('file shared.ts ');
  expect(cli(['why', 'control'])).not.toContain('unkeyed shared.ts');
  expect(cli(['why', 'projection'])).toContain('unkeyed config.json');
  r.write('shared.ts', `${changed}\n`);
  expect(cli(['why', 'direct'])).toContain("dirty input 'shared.ts'");
  r.git('reset', '--hard', to);
  const cases = [{ name: 'shared.ts', from, to, expect: ['representative'] }];
  for (const [path, content, expected] of [
    ['flows/common.yaml', 'appId: x\n---\n- runFlow: leaf.yaml\n# edit', ['flowRep']],
    ['config.json', '{"name":"b"}', ['configRep']],
    ['leaf.ts', 'export const value = 1;', ['closure', 'representative']],
    ['shared.ts', "import './other';", ['closure', 'representative']],
    ['flows/leaf.yaml', 'appId: x\n---\n- tapOn: Goodbye\n', ['flow', 'flowRep']],
  ] as const) {
    r.git('reset', '--hard', from);
    const to = r.commit({
      [path]: content,
      ...(path === 'shared.ts' ? { 'other.ts': 'export {};' } : {}),
    });
    cases.push({ name: path, from, to, expect: [...expected] });
  }
  const result = r.check(cases);
  expect(result.code, result.err + result.out).toBe(0);
  r.git('reset', '--hard', from);
  cli(['record', 'closure', '--outcome', 'green']);
  doc.unkeyed.push('leaf.ts');
  doc.tasks.representative.keyed?.push('leaf.ts');
  r.commit({ 'proof.yaml': JSON.stringify(doc) });
  const policy = cli(['why', 'closure']);
  expect(policy).toContain('now unkeyed leaf.ts');
  expect(policy).not.toContain('no inputs changed');
  cli(['record', 'closure', '--outcome', 'green']);
  doc.unkeyed.pop();
  doc.tasks.representative.keyed?.pop();
  r.commit({ 'proof.yaml': JSON.stringify(doc) });
  expect(cli(['why', 'closure'])).toContain('now keyed leaf.ts');
}, 30000);

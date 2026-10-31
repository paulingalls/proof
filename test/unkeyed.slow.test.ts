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
function fixture() {
  const r = new Repo();
  repos.push(r);
  const doc = {
    version: 1,
    project: 'unkeyed',
    include: 'proof.d/*.yaml',
    unkeyed: ['shared.ts', 'flows/common.yaml'],
    tasks: {
      direct: {
        ...task(['shared.ts']),
        run: `printf '%s' "$EXPECTED" | cmp - shared.ts`,
        env: ['EXPECTED'],
      },
      closure: {
        ...task([{ 'imports-of': 'entry.ts' }]),
        run: `printf '%s' "$EXPECTED" | cmp - shared.ts`,
        env: ['EXPECTED'],
      },
      flow: task([{ maestro: 'flows/main.yaml' }]),
      control: task(['control']),
      representative: task([{ 'imports-of': 'entry.ts' }], ['shared.ts']),
    },
  };
  r.commit({
    'proof.yaml': JSON.stringify(doc),
    'proof.d/tasks.yaml': JSON.stringify({
      tasks: { flowRep: task([{ maestro: 'flows/main.yaml' }], ['flows/common.yaml']) },
    }),
    'entry.ts': "import './shared';",
    'shared.ts': "import './leaf';",
    'leaf.ts': 'export {};',
    'flows/main.yaml': 'appId: x\n---\n- runFlow: common.yaml\n',
    'flows/common.yaml': 'appId: x\n---\n- runFlow: leaf.yaml\n',
    'flows/leaf.yaml': 'appId: x\n---\n- tapOn: Hello\n',
    control: 'ok',
  });
  const state = mkdtempSync(join(tmpdir(), 'proof-unkeyed-'));
  states.push(state);
  const cli = (args: string[], EXPECTED = "import './leaf';") => {
    const result = r.cli(args, { PROOF_STATE_DIR: state, EXPECTED });
    expect(result.code, result.err + result.out).toBe(0);
    return result.out;
  };
  return { r, doc, cli };
}
test('unkeyed declarations validate all files and representatives before task selection', () => {
  const { r, doc, cli } = fixture();
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
    for (const args of [
      ['plan'],
      ['run', '--tasks', 'control'],
      ['record', 'control', '--outcome', 'green'],
      ['why', 'control'],
      ['status', '--ref', 'HEAD'],
      ['lint'],
      ['doctor'],
      ['stats'],
      ['flakes'],
      ['invalidate', '--task', 'control'],
      ['check', '.git/cases.yaml'],
    ]) {
      r.write(
        '.git/cases.yaml',
        JSON.stringify([{ name: 'bad', from: 'HEAD', to: 'HEAD', expect: [] }]),
      );
      const result = r.cli(args);
      expect(result.code, result.err + result.out).toBe(2);
      expect(result.err + result.out).toContain(name);
    }
    r.git('reset', '--hard', head);
  }
  for (const [unkeyed, keyed, inputs] of [
    [['*.ts'], ['shared.ts'], ['shared.ts']],
    [['shared.ts'], ['shared.ts'], ['control']],
    [['absent'], ['shared.ts'], ['shared.ts']],
    [['shared.ts'], ['absent'], ['shared.ts']],
    [['shared.ts'], ['*.ts'], ['shared.ts']],
    [['!shared.ts'], [], ['shared.ts']],
    ['shared.ts', [], ['shared.ts']],
    [[], 'shared.ts', ['shared.ts']],
  ]) {
    r.write(
      'proof.yaml',
      JSON.stringify({
        version: 1,
        project: 'invalid',
        unkeyed,
        tasks: { a: { run: 'true', inputs, keyed } },
      }),
    );
    expect(r.cli(['plan']).code).toBe(2);
  }
  r.write('new.ts', 'export {};');
  r.write(
    'proof.yaml',
    JSON.stringify({
      version: 1,
      project: 'valid',
      unkeyed: ['*.ts'],
      tasks: {
        a: task(['*.ts'], ['entry.ts', 'shared.ts']),
        b: task(['*.ts'], ['leaf.ts', 'new.ts']),
      },
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
  r.write('shared.ts', `${changed}\n`);
  expect(cli(['why', 'direct'])).toContain("dirty input 'shared.ts'");
  r.git('reset', '--hard', to);
  const cases = [{ name: 'shared.ts', from, to, expect: ['representative'] }];
  for (const [path, content, expected] of [
    ['flows/common.yaml', 'appId: x\n---\n- runFlow: leaf.yaml\n# edit', ['flowRep']],
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
  doc.unkeyed.push('leaf.ts');
  doc.tasks.representative.keyed?.push('leaf.ts');
  r.commit({ 'proof.yaml': JSON.stringify(doc) });
  expect(cli(['why', 'closure'])).toContain('now unkeyed leaf.ts');
  cli(['record', 'closure', '--outcome', 'green']);
  r.commit({
    'proof.yaml': JSON.stringify({
      ...doc,
      unkeyed: ['shared.ts', 'flows/common.yaml'],
      tasks: { ...doc.tasks, representative: task([{ 'imports-of': 'entry.ts' }], ['shared.ts']) },
    }),
  });
  expect(cli(['why', 'closure'])).toContain('now keyed leaf.ts');
}, 30000);

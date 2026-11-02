import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Repo } from './support/repo';

const repos: Repo[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.close();
});
const task = (inputs: unknown[]) => ({ run: 'true', inputs });
function fixture() {
  const r = new Repo();
  repos.push(r);
  const marker = join(r.path, '.git/executed');
  const doc = {
    version: 1,
    project: 'super-only',
    include: 'proof.d/*.yaml',
    'super-only': ['test.sh', 'flows/*.yaml'],
    tasks: {
      direct: {
        run: `printf '%s' "$EXPECTED" | cmp - test.sh && printf '%s' "$EXPECTED" > '${marker}'`,
        inputs: ['test.sh'],
        env: ['EXPECTED'],
      },
      flow: task([{ maestro: 'flows/main.yaml' }]),
      control: task(['source.ts']),
    },
  };
  const baseline = r.commit({
    'proof.yaml': JSON.stringify(doc),
    'proof.d/flows.yaml': '{}',
    'test.sh': 'before',
    'source.ts': 'export {};',
    'flows/main.yaml': 'appId: x\n---\n- tapOn: Hello\n',
    'config.json': '{"name":"a"}',
  });
  const state = join(r.path, '.git/state');
  const raw = (args: string[], EXPECTED = 'before') =>
    r.cli(args, { PROOF_STATE_DIR: state, EXPECTED });
  const cli = (args: string[], EXPECTED = 'before') => {
    const result = raw(args, EXPECTED);
    expect(result.code, result.err + result.out).toBe(0);
    return result.out;
  };
  const plan = (args: string[] = []) =>
    JSON.parse(cli(['plan', '--json', ...args])) as {
      task: string;
      key: string;
      state: string;
      reason: string;
    }[];
  return { r, doc, baseline, marker, state, raw, cli, plan };
}

test('super-only bytes are delivered exactly, excluded from keys and explained without representatives', () => {
  const { r, cli, plan, marker } = fixture();
  const before = plan();
  expect(cli(['run'])).toContain('proof published');
  r.commit({
    'test.sh': 'after\n',
    'flows/main.yaml': 'appId: x\n---\n- tapOn: Goodbye\n',
  });
  expect(plan().map((row) => row.key)).toEqual(before.map((row) => row.key));
  expect(plan().every((row) => row.state === 'PROVEN')).toBe(true);
  cli(['run']);
  expect(readFileSync(marker, 'utf8')).toBe('before');
  for (const [id, path] of [
    ['direct', 'test.sh'],
    ['flow', 'flows/main.yaml'],
  ]) {
    const why = cli(['why', id as string]);
    expect(why.match(new RegExp(`^delivered not keyed super-only ${path}$`, 'gm'))).toHaveLength(1);
    expect(why).not.toContain(`file ${path} `);
    expect(why).not.toContain(`member ${path} `);
  }
  expect(cli(['why', 'control'])).not.toContain('super-only ');
  expect(cli(['run', '--fresh', '--tasks', 'direct'], 'after\n')).toContain('green direct');
  expect(readFileSync(marker, 'utf8')).toBe('after\n');
});

test('super-only validates before selection in every declaration reader', () => {
  const { r, doc, cli, raw } = fixture();
  cli(['plan']);
  for (const pattern of ['absent/**', '!test.sh']) {
    r.commit({ 'proof.yaml': JSON.stringify({ ...doc, 'super-only': [pattern] }) });
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
      'rekey',
    ]) {
      const result = raw(command.split(' '));
      expect(result.code, command + result.err + result.out).toBe(2);
      expect(result.err + result.out).toContain('super-only');
      expect(result.err + result.out).toContain(pattern);
    }
  }
  for (const [diagnostic, extra] of [
    [
      'is super-only',
      { tasks: { ...doc.tasks, direct: { ...doc.tasks.direct, keyed: ['test.sh'] } } },
    ],
    [
      'is also unkeyed',
      {
        unkeyed: ['test.*'],
        tasks: { ...doc.tasks, rep: { ...task(['test.sh']), keyed: ['test.sh'] } },
      },
    ],
  ] as const) {
    r.commit({ 'proof.yaml': JSON.stringify({ ...doc, ...extra }) });
    const result = raw(['plan']);
    expect(result.code, result.err + result.out).toBe(2);
    expect(result.err).toContain(`'test.sh' ${diagnostic}`);
  }
});

test('included declarations add exclusions to the root list', () => {
  const { r, doc, cli, plan } = fixture();
  doc['super-only'] = ['test.sh'];
  r.commit({
    'proof.yaml': JSON.stringify(doc),
    'proof.d/flows.yaml': JSON.stringify({ 'super-only': ['flows/*.yaml'] }),
  });
  const before = plan().map((row) => row.key);
  r.commit({ 'test.sh': 'after', 'flows/main.yaml': 'appId: x\n---\n- tapOn: Goodbye\n' });
  expect(plan().map((row) => row.key)).toEqual(before);
  expect(cli(['why', 'flow'])).toContain('super-only flows/main.yaml');
});

test('dirty received super-only files do not publish; unrelated tasks do', () => {
  const { r, cli, plan } = fixture();
  r.write('test.sh', 'dirty');
  const out = cli(['run', '--tasks', 'direct', 'control'], 'dirty');
  expect(out).toContain('green direct');
  expect(out).toContain('no proof published');
  expect(out).toContain("dirty input 'test.sh'");
  r.git('restore', 'test.sh');
  expect(plan().find((row) => row.task === 'direct')?.state).toBe('RUN');
  expect(plan().find((row) => row.task === 'control')?.state).toBe('PROVEN');
});

test('since leaves an unproven excluded-only edit unreached, while a new task runs', () => {
  const { r, doc, baseline, cli, plan, marker } = fixture();
  r.commit({ 'test.sh': 'after' });
  expect(plan().find((row) => row.task === 'direct')?.state).toBe('RUN');
  expect(plan(['--since', baseline]).find((row) => row.task === 'direct')?.state).toBe('UNREACHED');
  cli(['run', '--since', baseline]);
  expect(existsSync(marker)).toBe(false);
  cli(['run', '--tasks', 'direct'], 'after');
  Object.assign(doc.tasks, { new: doc.tasks.direct });
  r.commit({ 'proof.yaml': JSON.stringify(doc) });
  const row = plan().find((row) => row.task === 'new');
  expect(row?.state).toBe('RUN');
  expect(row?.reason).toContain('no proof for key');
  expect(cli(['run', '--tasks', 'new'], 'after')).toContain('green new');
});

test('carry migrates unchanged whole and projected inputs on adoption without executing or adding results', () => {
  const { r, doc, cli, plan, state, marker } = fixture();
  const tasks = {
    carry: { ...task(['test.sh', { path: 'config.json', json: ['name'] }]), carry: true },
  };
  doc['super-only'] = [];
  r.commit({ 'proof.yaml': JSON.stringify({ ...doc, tasks }) });
  cli(['record', 'carry', '--outcome', 'green']);
  const before = plan()[0]?.key;
  doc['super-only'] = ['test.sh', 'config.json'];
  r.commit({ 'proof.yaml': JSON.stringify({ ...doc, tasks }) });
  expect(plan()[0]?.key).not.toBe(before);
  expect(plan()[0]?.state).toBe('RUN');
  const why = cli(['why', 'carry']);
  expect(why).toContain('now super-only test.sh');
  expect(why).toContain('now super-only config.json');
  expect(why.match(/^delivered not keyed super-only .+$/gm)).toEqual([
    'delivered not keyed super-only config.json',
    'delivered not keyed super-only test.sh',
  ]);
  expect(why).not.toContain('now unkeyed');
  using db = new Database(join(state, 'proof.db'));
  const results = () => db.query('SELECT * FROM results').all();
  const old = results();
  expect(cli(['rekey'])).toContain('would carry 1');
  expect(plan()[0]?.state).toBe('RUN');
  expect(cli(['rekey', '--apply'])).toContain('carried 1');
  expect(plan()[0]?.state).toBe('PROVEN');
  expect(results()).toEqual(old);
  expect(existsSync(marker)).toBe(false);
  cli(['record', 'carry', '--outcome', 'green']);
  doc['super-only'] = [];
  r.commit({ 'proof.yaml': JSON.stringify({ ...doc, tasks }) });
  expect(cli(['why', 'carry'])).toContain('now keyed test.sh');
  expect(cli(['why', 'carry'])).toContain('now keyed config.json');
});

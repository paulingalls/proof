import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Repo } from './support/repo';

const repos: Repo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
});
const task = (dimensions?: unknown) => ({ run: 'true', inputs: ['input'], dimensions });
const base = { native: task(['tool']), plain: task() };
const doc = (dimensions: unknown, tasks: unknown = base, extra = {}) =>
  JSON.stringify({ version: 1, project: 'dimensions', dimensions, tasks, ...extra });
function fixture(source = doc({ tool: 'printf demo' })) {
  const repo = new Repo();
  repos.push(repo);
  repo.commit({ 'proof.yaml': source, input: 'input' });
  const env = { PROOF_STATE_DIR: join(repo.path, '.git/state'), TOOL: 'ambient' };
  const cli = (args: string[], code = 0, cwd = repo.path) => {
    const result = repo.cli(args, env, cwd);
    expect(result.code, result.out + result.err).toBe(code);
    return result.out + result.err;
  };
  const rows = (table = 'proofs') => {
    using db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
    return db.query(`SELECT * FROM ${table} ORDER BY task`).all() as Record<string, unknown>[];
  };
  return { repo, cli, rows };
}

test('dimension declarations validate every reader and included, unselected tasks', () => {
  const f = fixture(doc({}, { plain: task() }, { include: 'proof.d/*.yaml' }));
  f.repo.commit({ 'proof.d/tasks.yaml': JSON.stringify({ tasks: { native: task(['missing']) } }) });
  f.repo.write('.git/cases.yaml', '[{"name":"same","from":"HEAD","to":"HEAD","expect":[]}]');
  const commands = `plan;run --tasks plain;record plain --outcome green;why plain;
status --ref HEAD;lint;doctor;check .git/cases.yaml;stats;flakes;invalidate --task plain`;
  for (const command of commands.split(';'))
    expect(f.cli(command.trim().split(' '), 2)).toContain("unknown dimension 'missing'");
  for (const source of [
    doc({}, { native: { ...task(), inputs: [{ dotenv: 'dimension' }] } }),
    doc({}, {}, { inputs: { bad: [{ dotenv: 'dimension' }] } }),
    doc({ 'a:b': 'printf demo' }, {}),
  ]) {
    f.repo.commit({ 'proof.yaml': source });
    expect(f.cli(['plan'], 2)).toContain(source.includes('a:b') ? 'a:b' : 'dimension');
  }
});

test('dimension-only identity uses current values, stored hashes and each ref command', () => {
  const old = 'echo hit >> .git/old-counter; cat .git/value; printf "$TOOL"';
  const f = fixture(doc({ tool: old }));
  f.repo.write('.git/value', 'raw-marker-A');
  f.cli(['run', '--jobs', '2']);
  const a = f.repo.git('rev-parse', 'HEAD');
  expect(f.cli(['plan'], 0, join(f.repo.path, 'node_modules'))).toContain('PROVEN native');
  expect(JSON.parse(f.rows()[0]?.env_hashes as string)).toEqual([
    ['dimension:tool', new Bun.CryptoHasher('sha256').update('raw-marker-Aambient').digest('hex')],
  ]);
  for (const table of ['results', 'proofs'])
    expect(JSON.stringify(f.rows(table))).not.toContain('raw-marker');
  f.repo.write('.git/value', 'raw-marker-B');
  const plan = f.cli(['plan']);
  expect(plan).toContain('RUN native');
  expect(plan).toContain('PROVEN plain');
  expect(f.cli(['status', '--ref', a], 1)).toContain('RUN native');
  const count = () => Bun.file(join(f.repo.path, '.git/old-counter')).size;
  const before = count();
  const b = f.repo.commit({ 'proof.yaml': doc({ tool: 'printf raw-marker-B' }) });
  const why = f.cli(['why', 'native']);
  expect(why).toContain('changed env dimension:tool');
  expect(why).not.toContain('raw-marker');
  expect(count()).toBe(before);
  const c = f.repo.commit({ 'proof.yaml': doc({ tool: "printf '%s' raw-marker-B" }) });
  const cases = [
    { name: 'change', from: a, to: b, expect: ['native'] },
    { name: 'same value', from: b, to: c, expect: [] },
  ];
  f.repo.write('.git/cases.yaml', JSON.stringify(cases));
  expect(f.cli(['check', '.git/cases.yaml'])).toContain('PASS same value');
});

test('commands are lazy and cached throughout plan, run and stored-proof why', () => {
  const command = 'echo hit >> .git/counter; printf demo';
  const tasks = { native: task(['tool']), second: task(['alias']), plain: task() };
  const f = fixture(
    doc({ tool: command, alias: command }, { ...tasks, plain: { ...task(), sets: ['plain'] } }),
  );
  for (const command of ['plan', 'plan --set plain', 'run --jobs 2', 'why native', 'plan']) {
    const args = command.split(' ');
    const count = command.includes('--set') ? 0 : 1;
    f.repo.write('.git/counter', '');
    f.cli(args);
    expect(Bun.file(join(f.repo.path, '.git/counter')).size).toBe(count * 4);
  }
  expect(f.rows()).toHaveLength(3);
});

for (const output of ['printf raw-marker; printf raw-error >&2; exit 1', 'true', "printf '  \\n'"])
  test(`unavailable dimensions run without publication: ${output}`, () => {
    const tasks = { native: task(['tool']), second: task(['tool']), plain: task() };
    const f = fixture(doc({ tool: `echo hit >> .git/counter; ${output}` }, tasks));
    for (const args of [['plan'], ['why', 'native'], ['run', '--jobs', '2']]) {
      f.repo.write('.git/counter', '');
      const out = f.cli(args);
      expect(out).toContain("dimension 'tool'");
      expect(out).toContain(args[0] === 'run' ? 'not recorded' : 'undecidable');
      expect(out).not.toContain('raw-');
      expect(Bun.file(join(f.repo.path, '.git/counter')).size).toBe(4);
    }
    for (const table of ['results', 'proofs'])
      expect(f.rows(table).map((r) => r.task)).toEqual(['plain']);
  });

test('doctor reports every dimension value and failure before exiting', () => {
  const f = fixture(doc({ first: 'printf demo', broken: 'exit 1', last: 'printf last-value' }, {}));
  const report = f.cli(['doctor'], 1);
  expect(report).toContain('Dimension first: demo');
  expect(report).toContain("Dimension broken: unavailable (dimension 'broken': command failed)");
  expect(report).toContain('Dimension last: last-value');
  f.repo.commit({ 'proof.yaml': doc({ tool: 'printf demo' }) });
  expect(f.cli(['doctor'])).toContain('Dimension tool: demo');
});

import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Repo } from './support/repo';

const repos: Repo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
});
const task = (dimensions?: unknown) => ({ run: 'true', inputs: ['input'], dimensions });
const doc = (
  dimensions: unknown = {},
  tasks: unknown = { native: task(['tool']), plain: task() },
  extra = {},
) => JSON.stringify({ version: 1, project: 'dimensions', dimensions, tasks, ...extra });
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
    const db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
    try {
      return db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    } finally {
      db.close();
    }
  };
  return { repo, cli, rows };
}

test('dimension declarations validate every reader and included, unselected tasks', () => {
  const f = fixture(doc({}, { plain: task() }, { include: 'proof.d/*.yaml' }));
  f.repo.commit({ 'proof.d/tasks.yaml': JSON.stringify({ tasks: { native: task(['missing']) } }) });
  f.repo.write('.git/cases.yaml', '[{"name":"same","from":"HEAD","to":"HEAD","expect":[]}]');
  for (const command of [
    'plan',
    'run --tasks plain',
    'record plain --outcome green',
    'why plain',
    'status --ref HEAD',
    'lint',
    'doctor',
    'check .git/cases.yaml',
    'stats',
    'flakes',
    'invalidate --task plain',
  ])
    expect(f.cli(command.split(' '), 2)).toContain("task 'native': unknown dimension 'missing'");
  for (const [dimensions, names, diagnostic] of [
    [[], [], 'expected a mapping'],
    [{ tool: '' }, [], 'nonempty string'],
    [{ tool: 1 }, [], 'nonempty string'],
    [{ tool: 'true' }, 'tool', 'must be a list'],
    [{ tool: 'true' }, [''], 'nonempty string'],
    [{ tool: 'true' }, [1], 'nonempty string'],
  ]) {
    f.repo.commit({ 'proof.yaml': doc(dimensions, { native: task(names) }) });
    expect(f.cli(['plan'], 2)).toContain(diagnostic as string);
  }
  f.repo.commit({
    'proof.yaml': doc({ missing: 'printf demo' }, {}, { include: 'proof.d/*.yaml' }),
  });
  f.cli(['plan']);
  f.repo.commit({ 'proof.d/tasks.yaml': '{"dimensions":{"bad":"true"}}' });
  expect(f.cli(['plan'], 2)).toContain("unknown field 'dimensions'");
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
  f.repo.write('.git/value', 'raw-marker-A');
  expect(f.cli(['status', '--ref', a])).toContain('PROVEN native');
  const count = () => Bun.file(join(f.repo.path, '.git/old-counter')).size;
  const before = count();
  const b = f.repo.commit({ 'proof.yaml': doc({ tool: 'printf raw-marker-B' }) });
  const why = f.cli(['why', 'native']);
  expect(why).toContain('changed env dimension:tool');
  expect(why).not.toContain('raw-marker');
  expect(count()).toBe(before);
  const c = f.repo.commit({
    'proof.yaml': doc(
      { unused: 'exit 99', tool: "printf '%s' raw-marker-B" },
      { native: task(['tool', 'tool']), plain: task([]) },
    ),
  });
  f.repo.write(
    '.git/cases.yaml',
    JSON.stringify([
      { name: 'change', from: a, to: b, expect: ['native'] },
      { name: 'same value', from: b, to: c, expect: [] },
    ]),
  );
  expect(f.cli(['check', '.git/cases.yaml'])).toContain('PASS same value');
});

test('commands are lazy and cached throughout plan, run and stored-proof why', () => {
  const command = 'echo hit >> .git/counter; printf demo';
  const f = fixture(
    doc(
      { tool: command, alias: command },
      {
        native: task(['tool']),
        second: task(['alias']),
        plain: { ...task(), sets: ['plain'] },
      },
    ),
  );
  for (const [args, count] of [
    [['plan'], 1],
    [['plan', '--set', 'plain'], 0],
    [['run', '--jobs', '2'], 1],
    [['why', 'native'], 1],
    [['plan'], 1],
  ] as [string[], number][]) {
    f.repo.write('.git/counter', '');
    f.cli(args);
    expect(Bun.file(join(f.repo.path, '.git/counter')).size).toBe(count * 4);
  }
  expect(f.rows()).toHaveLength(3);
});

for (const output of ['printf raw-marker; printf raw-error >&2; exit 1', 'true', "printf '  \\n'"])
  test(`unavailable dimensions run without publication: ${output}`, () => {
    const f = fixture(
      doc(
        { tool: `echo hit >> .git/counter; ${output}` },
        { native: task(['tool']), second: task(['tool']), plain: task() },
      ),
    );
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

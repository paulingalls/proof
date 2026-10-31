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

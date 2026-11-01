import { Database } from 'bun:sqlite';
import { afterAll, afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Postgres } from './support/postgres';
import { Repo } from './support/repo';

const postgres = new Postgres();
afterAll(() => postgres.close());
const repos: Repo[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'proof-staged-'));
  dirs.push(dir);
  return dir;
}
function fixture(remote = '') {
  const repo = new Repo();
  repos.push(repo);
  const control = directory();
  const env = { PROOF_STATE_DIR: directory(), ...(remote ? { PROOF_STORE: remote } : {}) };
  const cli = (...args: string[]) => repo.cli(args, env);
  const rows = (table: string) => {
    const db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
    try {
      return db.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[];
    } finally {
      db.close();
    }
  };
  const document = (tasks: unknown, extra = {}) =>
    JSON.stringify({ version: 1, project: 'staged', tasks, ...extra });
  const task = {
    run: `test "$(cat input)" = staged && echo executed >> '${control}/log'`,
    inputs: ['input'],
  };
  repo.commit({ 'proof.yaml': document({ task }), input: 'original' });
  const stage = (files: Record<string, string> = { input: 'staged' }) => {
    for (const [path, bytes] of Object.entries(files)) repo.write(path, bytes);
    repo.git('add', ...Object.keys(files));
  };
  return { repo, control, env, cli, rows, document, task, stage };
}

for (const remote of [false, true]) {
  test(`staged green is reused after committing exactly the index; remote=${remote}`, async () => {
    if (remote) await postgres.start();
    const database = remote ? await postgres.database() : undefined;
    const f = fixture(database?.PROOF_STORE);
    const parent = f.repo.git('rev-parse', 'HEAD');
    f.stage();
    const run = f.cli('run', '--staged');
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain('green task; proof published');
    expect(f.rows('results')).toMatchObject([{ commit: `${parent} (staged)`, outcome: 'green' }]);
    f.repo.git('commit', '-qm', 'staged');
    expect(f.cli('plan').out).toContain('PROVEN task');
    expect(f.cli('run').out).toContain('PROVEN task');
    expect(readFileSync(join(f.control, 'log'), 'utf8')).toBe('executed\n');
    expect(f.rows('results')).toHaveLength(1);
    if (database) {
      expect(run.out).toContain('; shared');
      expect([...(await database.sql`SELECT outcome, "commit" FROM results`)]).toMatchObject([
        { outcome: 'green', commit: `${parent} (staged)` },
      ]);
      expect([...(await database.sql`SELECT key FROM proofs`)]).toMatchObject([
        { key: f.rows('results')[0]?.key },
      ]);
      const clone = new Repo(f.repo);
      repos.push(clone);
      const env = { PROOF_STORE: database.PROOF_STORE, PROOF_STATE_DIR: directory() };
      expect(clone.cli(['run'], env).out).toContain('PROVEN task');
      expect(clone.cli(['why', 'task'], env).out).toContain(
        'historical comparison unavailable: staged proof',
      );
      expect(readFileSync(join(f.control, 'log'), 'utf8')).toBe('executed\n');
      expect(await database.sql`SELECT id FROM results`).toHaveLength(1);
    }
  }, 120_000);
}

test('partial staging ignores untracked inputs and staged deletions left on disk', () => {
  const f = fixture();
  f.repo.commit({
    'proof.yaml': f.document({
      task: {
        ...f.task,
        run: `${f.task.run} && test ! -e extra && test ! -e outside/other && test ! -e deleted`,
        inputs: ['*', '!proof.yaml'],
      },
    }),
    deleted: 'old',
  });
  f.stage();
  f.repo.git('rm', '--cached', 'deleted');
  f.repo.write('input', 'working');
  f.repo.write('extra', 'untracked matching input');
  f.repo.write('outside/other', 'untracked');
  const result = f.cli('run', '--staged');
  expect(result.code, result.out + result.err).toBe(0);
  expect(result.out).toContain('green task; proof published');
  f.repo.git('commit', '-qm', 'index only');
  expect(f.cli('status', '--ref', 'HEAD').out).toContain('PROVEN task');
  expect(f.cli('plan').out).toContain('dirty input');
  for (const path of ['extra', 'outside/other', 'deleted']) rmSync(join(f.repo.path, path));
  f.repo.git('restore', 'input');
  expect(f.cli('plan').out).toContain('PROVEN task');
  expect(f.cli('run').out).toContain('PROVEN task');
  f.repo.commit({ input: 'different' });
  expect(f.cli('plan').out).toContain('RUN task');
});

test('staged declarations, includes, providers and both selectors share the index view', () => {
  const f = fixture();
  const task = { ...f.task, sets: ['commit'], needs: ['service'] };
  f.stage({
    input: 'staged',
    'proof.yaml': f.document(
      { task },
      {
        include: 'staged/*.yaml',
        providers: { service: { start: `echo provider >> '${f.control}/log'` } },
      },
    ),
    'staged/tasks.yaml': JSON.stringify({ tasks: { included: task } }),
  });
  f.repo.write('proof.yaml', f.document({ wrong: { run: 'exit 1', inputs: ['input'] } }));
  f.repo.write('staged/tasks.yaml', JSON.stringify({ tasks: { wrongInclude: task } }));
  f.repo.write('staged/extra.yaml', JSON.stringify({ tasks: { untracked: task } }));
  const run = f.cli('run', '--staged', '--set', 'commit');
  expect(run.code, run.err).toBe(0);
  expect(run.out).toContain('green task; proof published');
  expect(run.out).toContain('green included; proof published');
  expect(run.out).not.toContain('wrong');
  expect(run.out).not.toContain('untracked');
  expect(readFileSync(join(f.control, 'log'), 'utf8')).toBe('provider\nexecuted\nexecuted\n');
  const explicit = f.repo.cli(['run', '--staged', '--tasks', 'included'], {
    PROOF_STATE_DIR: directory(),
  });
  expect(explicit.code, explicit.err).toBe(0);
  expect(explicit.out).toContain('green included; proof published');
  expect(explicit.out).not.toContain('green task');
  f.repo.git('commit', '-qm', 'declarations');
  f.repo.git('restore', 'proof.yaml', 'staged/tasks.yaml');
  rmSync(join(f.repo.path, 'staged/extra.yaml'));
  expect(f.cli('plan', '--set', 'commit').out.match(/PROVEN/g)).toHaveLength(2);
});

test('staged red retains ordinary contest and recovery rules despite checkout dirt', () => {
  const f = fixture();
  f.repo.commit({
    'proof.yaml': f.document({
      task: { ...f.task, run: `${f.task.run} && test ! -e '${f.control}/red'` },
    }),
  });
  f.stage();
  f.repo.write('input', 'working');
  writeFileSync(join(f.control, 'red'), 'red');
  expect(f.cli('run', '--staged').code).toBe(1);
  expect(f.rows('results')).toMatchObject([{ outcome: 'red', dirty: 0 }]);
  rmSync(join(f.control, 'red'));
  expect(f.cli('run', '--staged').code).toBe(0);
  f.repo.git('commit', '-qm', 'target');
  f.repo.git('restore', 'input');
  expect(f.cli('record', 'task', '--outcome', 'red').code).toBe(0);
  f.repo.write('input', 'working');
  writeFileSync(join(f.control, 'red'), 'red');
  expect(f.cli('run', '--staged').code).toBe(1);
  expect(f.rows('proofs')).toEqual([]);
  expect(f.rows('contradictions')).toMatchObject([
    { kind: 'ordinary', deleted_proof: 0 },
    { kind: 'ordinary', deleted_proof: 1 },
  ]);
  expect(new Set(f.rows('results').map((row) => row.key)).size).toBe(1);
  rmSync(join(f.control, 'red'));
  expect(f.cli('run', '--staged').code).toBe(0);
  f.repo.git('restore', 'input');
  expect(f.cli('record', 'task', '--outcome', 'red').code).toBe(0);
  f.repo.write('input', 'working');
  expect(f.cli('run', '--staged').out).toContain('green task; proof published');
  expect(f.cli('status', '--ref', 'HEAD').out).toContain('PROVEN task');
});

test('unmerged index fails loudly; staged merge resolution publishes before merge commit', () => {
  const f = fixture();
  f.repo.git('checkout', '-qb', 'side');
  f.repo.commit({ input: 'side' });
  f.repo.git('checkout', '-qb', 'main', 'HEAD~1');
  f.repo.commit({ input: 'main' });
  expect(() => f.repo.git('merge', 'side')).toThrow();
  const conflict = f.cli('run', '--staged');
  expect(conflict.code).toBe(2);
  expect(conflict.err).toContain('input: unmerged');
  f.stage();
  const resolved = f.cli('run', '--staged');
  expect(resolved.code, resolved.err).toBe(0);
  expect(resolved.out).toContain('green task; proof published');
  expect(f.rows('results')).toHaveLength(1);
  f.repo.git('commit', '-qm', 'merge');
  expect(f.cli('plan').out).toContain('PROVEN task');
});

test('a projected input absent from the index never falls back to disk', () => {
  const f = fixture();
  f.repo.commit({
    'proof.yaml': f.document({
      task: {
        run: 'test ! -e absent.json && echo snapshot-absence',
        inputs: ['input', { path: 'absent.json', json: ['value'] }],
      },
    }),
  });
  f.repo.write('absent.json', '{"value":1}');
  const run = f.cli('run', '--staged');
  expect(run.code, run.err).toBe(0);
  expect(run.out).toContain('snapshot-absence');
  expect(run.out).toContain('not recorded:');
  expect(run.out).toContain("missing input 'absent.json'");
  expect(f.rows('results')).toEqual([]);
  expect(f.rows('proofs')).toEqual([]);
});

test('why never compares a staged proof to its parent; fresh and staged are incompatible', () => {
  const f = fixture();
  f.stage();
  expect(f.cli('run', '--staged').code).toBe(0);
  f.repo.git('commit', '-qm', 'target');
  const why = f.cli('why', 'task');
  expect(why.code, why.err).toBe(0);
  expect(why.out).toContain('file input');
  expect(why.out).toContain('(staged)');
  expect(why.out).toContain('historical comparison unavailable: staged proof');
  expect(why.out).not.toMatch(/(?:changed|added|removed) file|no inputs changed/);
  for (const args of [
    ['--staged', '--fresh'],
    ['--fresh', '--staged'],
  ]) {
    const invalid = f.cli('run', ...args);
    expect(invalid.code).toBe(2);
    expect(invalid.err).toContain('usage: proof run');
  }
  expect(f.rows('results')).toHaveLength(1);
  expect(readFileSync(join(f.control, 'log'), 'utf8')).toBe('executed\n');
});

test('provider index mutations cannot replace captured declarations, inputs or workspace exports', () => {
  const f = fixture();
  const task = (name: string) => ({
    run: `${f.task.run} && '${process.execPath}' --no-install main.ts && echo ${name}`,
    inputs: ['input', { 'imports-of': 'main.ts' }],
    links: ['node_modules'],
    needs: ['service'],
  });
  const extra = { providers: { service: { start: `sh '${f.control}/replace'` } } };
  const original = f.document({ first: task('first'), second: task('second') }, extra);
  f.repo.commit({
    'proof.yaml': original,
    'package.json': '{"workspaces":["packages/*"]}',
    'packages/shared/package.json': '{"name":"shared","exports":"./head.ts"}',
    'packages/shared/head.ts': "throw new Error('HEAD export');",
    'packages/shared/staged.ts': "console.log('captured-export');",
    'packages/shared/working.ts': "throw new Error('working export');",
    'main.ts': "import 'shared';",
  });
  symlinkSync('../packages/shared', join(f.repo.path, 'node_modules/shared'));
  f.stage({
    input: 'staged',
    'packages/shared/package.json': '{"name":"shared","exports":"./staged.ts"}',
  });
  f.repo.write('packages/shared/package.json', '{"name":"shared","exports":"./working.ts"}');
  writeFileSync(
    join(f.control, 'replacement'),
    f.document(
      {
        first: { ...task('first'), run: 'echo replacement-first; exit 1' },
        second: { ...task('second'), run: 'echo replacement-second; exit 1' },
      },
      extra,
    ),
  );
  writeFileSync(
    join(f.control, 'replace'),
    `cp '${f.control}/replacement' proof.yaml
printf replacement > input
git add proof.yaml input packages/shared/package.json\n`,
  );
  const parent = f.repo.git('rev-parse', 'HEAD');
  const run = f.cli('run', '--staged');
  expect(run.code, run.out + run.err).toBe(0);
  expect(run.out.match(/captured-export/g)).toHaveLength(2);
  expect(run.out).not.toContain('replacement-');
  expect(f.rows('results')).toMatchObject([
    { task: 'first', outcome: 'green', commit: `${parent} (staged)` },
    { task: 'second', outcome: 'green', commit: `${parent} (staged)` },
  ]);
  expect(run.out).toContain(
    "no proof published: provider can see unstaged 'packages/shared/package.json'",
  );
  expect(f.rows('proofs')).toEqual([]);
});

test('a provider reading unstaged bytes neither earns a proof nor contests one', () => {
  const f = fixture();
  const gate = {
    run: `test "$(cat '${f.control}/served')" = good`,
    inputs: ['input'],
    needs: ['service'],
  };
  const extra = { providers: { service: { start: `cp input '${f.control}/served'` } } };
  f.repo.commit({ 'proof.yaml': f.document({ gate }, extra), input: 'bad' });
  f.repo.write('input', 'good');
  const earned = f.cli('run', '--staged');
  expect(earned.code).toBe(0);
  expect(earned.out).toContain("no proof published: provider can see unstaged 'input'");
  expect(f.rows('proofs')).toEqual([]);

  f.repo.commit({ input: 'good' });
  expect(f.cli('run').code).toBe(0);
  expect(f.cli('record', 'gate', '--outcome', 'red').code).toBe(0);
  f.repo.write('input', 'bad');
  expect(f.cli('run', '--staged').code).toBe(1);
  expect(f.rows('proofs')).toHaveLength(1);
});

test('provider checkout-only unignored glob matches cannot publish or contest', () => {
  const f = fixture();
  const gate = {
    run: `test "$(cat '${f.control}/served')" = good`,
    inputs: ['input*'],
    needs: ['service'],
    sets: ['commit', 'push'],
  };
  f.repo.commit({
    'proof.yaml': f.document(
      { gate },
      {
        providers: { service: { start: `cat input* > '${f.control}/served'` } },
      },
    ),
    input: '',
  });
  f.repo.write('input-extra', 'good');
  const earned = f.cli('run', '--staged', '--set', 'commit');
  expect(earned.code, earned.err).toBe(0);
  expect(earned.out).toContain("no proof published: provider can see unstaged 'input-extra'");
  expect(f.rows('proofs')).toEqual([]);
  rmSync(join(f.repo.path, 'input-extra'));
  expect(f.cli('run', '--set', 'push').code).toBe(1);

  f.repo.commit({ input: 'good' });
  expect(f.cli('run').code).toBe(0);
  expect(f.cli('record', 'gate', '--outcome', 'red').code).toBe(0);
  f.repo.write('input-extra', 'bad');
  expect(f.cli('run', '--staged').code).toBe(1);
  expect(f.rows('proofs')).toHaveLength(1);
  expect(f.rows('contradictions')).toHaveLength(1);
  rmSync(join(f.repo.path, 'input-extra'));
  expect(f.cli('run', '--set', 'push').out).toContain('green gate; proof published');
  expect(f.cli('plan', '--set', 'push').out).toContain('PROVEN gate');
});

for (const shared of [false, true]) {
  test(`provider startup mismatch survives restoration; later dependent=${shared}`, () => {
    const f = fixture();
    const gate = {
      run: `test "$(cat '${f.control}/served')" = good`,
      inputs: ['input'],
      needs: ['service'],
    };
    const tasks = shared
      ? { first: { run: 'true', inputs: ['stable'], needs: ['service'] }, gate }
      : { gate };
    f.repo.commit({
      'proof.yaml': f.document(tasks, {
        providers: { service: { start: `cp input '${f.control}/served'; git restore input` } },
      }),
      input: 'bad',
      stable: 'unchanged',
    });
    f.repo.write('input', 'good');
    const earned = f.cli('run', '--staged');
    expect(earned.code, earned.err).toBe(0);
    expect(earned.out).toContain(
      "green gate; no proof published: provider can see unstaged 'input'",
    );
    expect(f.rows('proofs').filter((row) => row.task === 'gate')).toEqual([]);
    expect(f.repo.git('status', '--porcelain')).toBe('');
    expect(f.cli('run').code).toBe(1);

    f.repo.commit({ input: 'good' });
    expect(f.cli('run').code).toBe(0);
    expect(f.cli('record', 'gate', '--outcome', 'red').code).toBe(0);
    f.repo.write('input', 'bad');
    const red = f.cli('run', '--staged');
    expect(red.code, red.err).toBe(1);
    expect(red.out).toContain("red gate; no proof published: provider can see unstaged 'input'");
    expect(f.rows('proofs').filter((row) => row.task === 'gate')).toHaveLength(1);
    expect(f.rows('contradictions')).toHaveLength(1);
    expect(f.repo.git('status', '--porcelain')).toBe('');
    expect(f.cli('run').out).toContain('green gate; proof published');
  });
}

test('staged sandbox still fails an undeclared relative read', () => {
  const f = fixture();
  f.repo.commit({
    'proof.yaml': f.document({ task: { ...f.task, run: 'cat hidden' } }),
    hidden: 'secret',
  });
  f.stage();
  const run = f.cli('run', '--staged');
  expect(run.code).toBe(1);
  expect(run.out).toContain('hidden');
  expect(f.rows('results')).toMatchObject([{ outcome: 'red', dirty: 0 }]);
  expect(f.rows('proofs')).toEqual([]);
});

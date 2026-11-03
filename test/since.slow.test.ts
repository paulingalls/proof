import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scene() {
  const repo = new Repo();
  repos.push(repo);
  const dir = mkdtempSync(join(tmpdir(), 'proof-since-'));
  dirs.push(dir);
  const env = { PROOF_STATE_DIR: join(dir, 'state') };
  const task = (id: string, extra = {}) => ({
    run: `touch '${dir}/${id}'`,
    inputs: [id],
    sets: ['push'],
    ...extra,
  });
  const tasks = { reached: task('reached'), unreached: task('unreached') };
  const document = (changes = {}) =>
    JSON.stringify({ version: 1, project: 'since', tasks, ...changes });
  const base = repo.commit({ 'proof.yaml': document(), reached: 'old', unreached: 'same' });
  const cli = (...args: string[]) => repo.cli(args, env);
  const rows = () => {
    const result = cli('plan', '--json', '--since', base);
    expect(result.code).toBe(0);
    return JSON.parse(result.out) as {
      task: string;
      state: string;
      reason: string;
      key?: string;
    }[];
  };
  const records = (table: string) => {
    const db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
    try {
      return db.query(`SELECT task FROM ${table} ORDER BY rowid`).all();
    } finally {
      db.close();
    }
  };
  const control = () => expect(rows().find((r) => r.task === 'unreached')?.state).toBe('UNREACHED');
  return { repo, dir, env, task, tasks, document, base, cli, rows, records, control };
}

test('since narrows plan and run, selectors and jobs without recording unreached work', () => {
  for (const selector of [[], ['--set', 'push'], ['--tasks', 'reached', 'unreached']]) {
    const s = scene();
    s.repo.commit({ reached: 'new' });
    if (selector.length)
      s.repo.commit({
        'proof.yaml': s.document({
          tasks: { ...s.tasks, excluded: s.task('reached', { run: 'exit 1', sets: ['other'] }) },
        }),
      });
    expect(
      s
        .rows()
        .filter((r) => r.task !== 'excluded')
        .map((r) => r.state),
    ).toEqual(['RUN', 'UNREACHED']);
    const plain = s.cli('plan', '--since', s.base);
    expect(plain.out).toContain(`UNREACHED unreached: unreached since ${s.base}`);
    expect(s.cli('plan').out).toContain('RUN unreached: no proof for key');
    const result = s.cli('run', '--jobs', '2', '--since', s.base, ...selector);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`UNREACHED unreached: unreached since ${s.base}`);
    expect(existsSync(join(s.dir, 'reached'))).toBe(true);
    expect(existsSync(join(s.dir, 'unreached'))).toBe(false);
    expect(s.records('results')).toEqual([{ task: 'reached' }]);
    expect(s.records('skips')).toEqual([]);
    const counts = 'green 1, red 0, incomplete 0, proven 0, unreached 1';
    expect(result.out.match(/^progress:/gm)).toHaveLength(2);
    expect(result.out).toContain(`progress: 2/2 done; ${counts}; task reached\n`);
    expect(result.out).toEndWith(`summary: ${counts}\n`);
    const again = s.cli('run', '--since', s.base, '--jobs', '2', ...selector);
    expect(again.code).toBe(0);
    expect(again.out.match(/^progress:/gm)).toHaveLength(1);
    expect(again.out).toMatch(/^progress: .*; task unreached$/m);
    expect(again.out.match(/^PROVEN reached:/gm)).toHaveLength(1);
    expect(again.out.match(/^UNREACHED unreached:/gm)).toHaveLength(2);
    expect(again.out).toEndWith('summary: green 0, red 0, incomplete 0, proven 1, unreached 1\n');
  }
});

test('current proof wins even across changed or absent historical tasks; contests run', () => {
  const s = scene();
  s.tasks.reached = s.task('reached', { run: 'true' });
  s.repo.commit({ 'proof.yaml': s.document(), reached: 'new' });
  expect(s.cli('record', 'reached', '--outcome', 'green').code).toBe(0);
  s.control();
  expect(s.rows()[0]?.state).toBe('PROVEN');
  const ordinary = JSON.parse(s.cli('plan', '--json').out);
  expect(s.rows()[0]).toEqual(ordinary[0]);
  expect(s.cli('run', '--since', s.base).code).toBe(0);
  expect(s.records('skips')).toEqual([{ task: 'reached' }]);
  expect(s.cli('record', 'reached', '--outcome', 'red').code).toBe(0);
  const head = s.repo.git('rev-parse', 'HEAD');
  expect(s.cli('run', '--since', head).out).toContain('RUN reached: contested:');
  expect(s.rows()[0]?.state).toBe('PROVEN');
  s.repo.commit({
    'proof.yaml': s.document({ tasks: { ...s.tasks, added: s.task('added') } }),
    added: 'a',
  });
  expect(s.cli('record', 'added', '--outcome', 'green').code).toBe(0);
  expect(s.rows().find((r) => r.task === 'added')?.state).toBe('PROVEN');
});

test('absent tasks and undecidable historical inputs run and explain why', () => {
  const s = scene();
  const old = s.repo.commit({
    'proof.yaml': s.document({ tasks: { ...s.tasks, repaired: s.task('missing') } }),
  });
  s.repo.commit({
    'proof.yaml': s.document({
      tasks: { ...s.tasks, repaired: s.task('missing'), added: s.task('added') },
    }),
    missing: 'now',
    added: 'new',
  });
  s.control();
  const result = s.cli('run', '--since', old);
  expect(result.code).toBe(0);
  expect(result.out).toContain(`task absent at ${old}`);
  expect(result.out).toContain(`undecidable at ${old}: missing input 'missing'`);
  expect(existsSync(join(s.dir, 'missing'))).toBe(true);
  expect(existsSync(join(s.dir, 'added'))).toBe(true);
});

test('dirty and currently undecidable tasks never become unreached', () => {
  for (const mode of ['unstaged', 'staged', 'untracked', 'missing', 'declaration']) {
    const s = scene();
    if (mode === 'missing') {
      s.repo.commit({
        'proof.yaml': s.document({ tasks: { ...s.tasks, reached: s.task('missing') } }),
      });
    } else if (mode === 'declaration') {
      s.repo.write(
        'proof.yaml',
        s.document({ tasks: { ...s.tasks, reached: s.task('reached', { run: 'true' }) } }),
      );
    } else if (mode === 'untracked') {
      s.tasks.reached.inputs = ['reached*'];
      s.repo.commit({ 'proof.yaml': s.document() });
      s.repo.write('reached-new', 'new');
    } else {
      s.repo.write('reached', 'dirty');
      if (mode === 'staged') s.repo.git('add', 'reached');
    }
    if (mode !== 'declaration') s.control();
    const result = s.cli('run', '--since', s.repo.git('rev-parse', 'HEAD'));
    expect(result.code).toBe(0);
    expect(result.out).toContain('RUN reached: undecidable:');
    expect(result.out).toContain('green reached');
  }
});

test('unreadable historical declarations run rather than blocking selection', () => {
  for (const content of [
    undefined,
    '{"version":999}',
    JSON.stringify({
      version: 1,
      project: 'since',
      generate: { run: 'exit 1', inputs: ['reached'] },
      tasks: {},
    }),
  ]) {
    const s = scene();
    if (content === undefined) s.repo.git('rm', 'proof.yaml');
    else s.repo.write('proof.yaml', content);
    s.repo.git('add', '.');
    s.repo.git('commit', '-qm', 'unreadable');
    const old = s.repo.git('rev-parse', 'HEAD');
    s.repo.commit({ 'proof.yaml': s.document() });
    s.control();
    const result = s.cli('run', '--since', old);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`RUN unreached: undecidable at ${old}:`);
    expect(existsSync(join(s.dir, 'unreached'))).toBe(true);
  }
});

test('run, links and dimension declarations enter the comparison', () => {
  for (const field of ['run', 'links', 'dimensions']) {
    const s = scene();
    const original = s.rows()[0]?.key;
    const change =
      field === 'run'
        ? { run: `true; ${s.tasks.reached.run}` }
        : field === 'links'
          ? { links: ['node_modules'] }
          : { dimensions: ['tool'] };
    s.repo.commit({
      'proof.yaml': s.document({
        dimensions: { tool: 'printf new' },
        tasks: { ...s.tasks, reached: s.task('reached', change) },
      }),
    });
    s.control();
    expect(s.rows()[0]?.key).not.toBe(original);
    expect(s.cli('run', '--since', s.base).code).toBe(0);
    expect(existsSync(join(s.dir, 'reached'))).toBe(true);
  }
});

test('unreached tasks start no provider and earn no savings, including prior red only', () => {
  const s = scene();
  s.repo.commit({
    'proof.yaml': s.document({
      providers: { service: { start: `touch '${s.dir}/provider'; exit 1` } },
      tasks: { unreached: s.task('unreached', { needs: ['service'] }) },
    }),
  });
  const base = s.repo.git('rev-parse', 'HEAD');
  expect(s.cli('run', '--since', base).code).toBe(0);
  expect(s.records('results')).toEqual([]);
  const empty = JSON.parse(s.cli('stats', '--json').out);
  expect(empty.tasks[0].runs).toBe(0);
  expect(empty.saved.current.seconds).toBe(0);
  expect(empty.saved.current.unpricedSkips).toBe(0);
  expect(s.cli('record', 'unreached', '--outcome', 'red').code).toBe(0);
  const result = s.cli('run', '--since', base);
  expect(result.code).toBe(0);
  expect(result.out).toContain('UNREACHED unreached');
  expect(existsSync(join(s.dir, 'provider'))).toBe(false);
  expect(existsSync(join(s.dir, 'unreached'))).toBe(false);
  expect(s.records('results')).toEqual([{ task: 'unreached' }]);
  expect(s.records('skips')).toEqual([]);
  const stats = JSON.parse(s.cli('stats', '--json').out);
  expect(stats.saved.current.seconds).toBe(0);
  expect(stats.saved.current.unpricedSkips).toBe(0);
});

test('unknown refs fail even with proof; mode conflicts and missing refs are usage errors', () => {
  const s = scene();
  s.control();
  for (const id of ['reached', 'unreached'])
    expect(s.cli('record', id, '--outcome', 'green').code).toBe(0);
  for (const command of ['plan', 'run']) {
    const result = s.cli(command, '--since', 'unknown-ref');
    expect(result.code).toBe(2);
    expect(result.err).toContain("ref 'unknown-ref'");
    for (const args of [
      ['--since'],
      ['--since', '--json'],
      ['--since', s.base, '--since', s.base],
    ]) {
      expect(s.cli(command, ...args).code).toBe(2);
    }
  }
  for (const mode of ['--fresh', '--staged']) {
    expect(s.cli('run', mode, '--since', s.base).code).toBe(2);
    expect(s.cli('run', '--since', s.base, mode).code).toBe(2);
  }
  expect(existsSync(join(s.dir, 'reached'))).toBe(false);
});

test('dimension commands compare now at both refs, including changed commands', () => {
  const s = scene();
  const tool = join(s.dir, 'tool');
  writeFileSync(tool, 'old');
  const tasks = { ...s.tasks, reached: s.task('reached', { dimensions: ['tool'] }) };
  const document = (command: string) => s.document({ tasks, dimensions: { tool: command } });
  const base = s.repo.commit({ 'proof.yaml': document(`cat '${tool}'`) });
  const oldKey = s.rows()[0]?.key;
  writeFileSync(tool, 'new');
  const now = JSON.parse(s.cli('plan', '--since', base, '--json').out);
  expect(now[0].key).not.toBe(oldKey);
  expect(now.map((row: { state: string }) => row.state)).toEqual(['UNREACHED', 'UNREACHED']);
  s.repo.commit({ 'proof.yaml': document('printf different') });
  expect(s.cli('run', '--since', base).out).toContain('green reached');
  expect(existsSync(join(s.dir, 'reached'))).toBe(true);
});

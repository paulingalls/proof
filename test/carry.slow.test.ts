import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Postgres } from './support/postgres';
import { Repo } from './support/repo';

const pg = new Postgres();
const repos: Repo[] = [];
beforeAll(() => pg.start(), 60_000);
afterAll(() => pg.close());
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
});
function fixture(PROOF_STORE?: string, inputs: unknown[] = ['a']) {
  const repo = new Repo();
  repos.push(repo);
  const doc = {
    version: 1,
    project: 'carry',
    tasks: { journey: { run: 'touch marker', inputs, carry: true } as Record<string, unknown> },
  };
  const commit = repo.commit({
    'proof.yaml': JSON.stringify(doc),
    a: 'a',
    b: 'b',
    c: 'c',
    'data.json': '{"chosen":1,"other":1}',
    '[id].json': '{"chosen":1}',
    'package.json': '{"version":"1"}',
  });
  const env = { PROOF_STORE, PROOF_STATE_DIR: join(repo.path, '.git/state') };
  const cli = (args: string[], code = 0) => {
    const r = repo.cli(args, env);
    expect(r.code, r.out + r.err).toBe(code);
    return r;
  };
  const plan = () => JSON.parse(cli(['plan', '--json']).out)[0];
  const query = (sql: string, ...values: (string | number | null)[]) => {
    using db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
    return db.query(sql).all(...values);
  };
  const update = (files = {}) => repo.commit({ 'proof.yaml': JSON.stringify(doc), ...files });
  cli(['record', 'journey', '--outcome', 'green']);
  return { repo, doc, commit, env, cli, plan, query, update };
}

for (const shared of [false, true])
  test(`widening publishes ordinary proof and retains contest behavior (${shared})`, async () => {
    const remote = shared ? await pg.database() : undefined;
    const f = fixture(remote?.PROOF_STORE);
    f.doc.tasks.journey.inputs = ['a', 'b', 'c'];
    f.update();
    expect(f.plan().state).toBe('RUN');
    const before = f.query('SELECT * FROM results');
    const proofs = f.query('SELECT * FROM proofs');
    const preview = f.cli(['rekey']).out;
    expect(preview).toContain('local: would carry 1');
    for (const text of ['journey', f.commit, 'added input b', 'added input c'])
      expect(preview).toContain(text);
    expect(f.query('SELECT * FROM proofs')).toEqual(proofs);
    expect(f.cli(['rekey', '--apply']).out).toContain('local: carried 1');
    expect(f.query('SELECT * FROM results')).toEqual(before);
    expect(f.query('SELECT * FROM proofs')).toHaveLength(2);
    expect(f.plan().state).toBe('PROVEN');
    expect(f.cli(['plan']).out).toContain(f.commit.slice(0, 8));
    expect(f.cli(['rekey', '--apply']).out).toContain('local: carried 0');
    expect(existsSync(join(f.repo.path, 'marker'))).toBe(false);
    if (remote) {
      const clone = new Repo(f.repo);
      repos.push(clone);
      const r = clone.cli(['plan', '--json'], {
        ...f.env,
        PROOF_STATE_DIR: join(clone.path, '.git/state'),
      });
      expect(r.code, r.err).toBe(0);
      expect(JSON.parse(r.out)[0].state).toBe('PROVEN');
      expect(await remote.sql`SELECT * FROM results`).toHaveLength(1);
    }
    f.cli(['record', 'journey', '--outcome', 'red']);
    expect(f.plan().state).toBe('RUN');
    expect(f.cli(['rekey', '--apply']).out).toContain('local: carried 0');
    f.cli(['record', 'journey', '--outcome', 'red']);
    expect(f.cli(['rekey', '--apply']).out).toContain('contested: 1');
    f.doc.tasks.journey.inputs = ['a', 'b', 'c', 'package.json'];
    f.update();
    expect(f.cli(['rekey', '--apply']).out).toContain('contested: 1');
    expect(f.plan().state).toBe('RUN');
    f.cli(['record', 'journey', '--outcome', 'green']);
    expect(f.plan().state).toBe('PROVEN');
  }, 30_000);

test('historical eligibility counts opt-outs, byte/mode changes and declaration boundaries', () => {
  for (const [name, reason] of [
    ['absent', 'key differs'],
    ['false', 'key differs'],
    ['bytes', 'input changed'],
    ['mode', 'input changed'],
    ['new', 'input changed'],
    ['newest', 'input changed'],
    ['run', 'declaration differs'],
    ['links', 'declaration differs'],
    ['missing commit', 'commit unavailable'],
    ['deleted', 'input deleted'],
    ['projection deleted', 'input deleted'],
    ['member', 'input changed'],
    ['unkeyed', 'input changed'],
    ['version', 'input changed'],
    ['missing task', 'declarations unavailable'],
    ['invalid history', 'declarations unavailable'],
  ]) {
    const projection = name?.includes('projection') || name === 'member';
    const f = fixture(undefined, projection ? [{ path: 'data.json', json: ['chosen'] }] : ['a']);
    const t = f.doc.tasks.journey;
    t.inputs = ['b', ...(projection ? [{ path: 'data.json', json: ['chosen'] }] : ['a'])];
    let files: Record<string, string> = {};
    if (name === 'absent') delete t.carry;
    if (name === 'false') t.carry = false;
    if (name === 'bytes' || name === 'unkeyed') files = { a: 'changed' };
    if (name === 'unkeyed') {
      Object.assign(f.doc, { unkeyed: ['a'] });
      Object.assign(f.doc.tasks, { representative: { run: 'true', inputs: ['a'], keyed: ['a'] } });
    }
    if (name === 'version') {
      t.inputs = ['a', 'package.json'];
      files = { 'package.json': '{"version":"2"}' };
    }
    if (name === 'mode') chmodSync(join(f.repo.path, 'a'), 0o755);
    if (name === 'new') {
      t.inputs = ['a', 'new'];
      files = { new: 'new' };
    }
    if (name === 'newest') {
      f.repo.commit({ a: 'different' });
      f.cli(['record', 'journey', '--outcome', 'green']);
      files = { a: 'a' };
    }
    if (name === 'run') t.run = 'false';
    if (name === 'links') t.links = ['node_modules'];
    if (name === 'missing commit') f.query('UPDATE results SET "commit" = ?', '0'.repeat(40));
    if (name?.includes('deleted')) {
      f.repo.git('rm', projection ? 'data.json' : 'a');
      t.inputs = ['b'];
    }
    if (name === 'member') files = { 'data.json': '{"chosen":2,"other":1}' };
    if (name === 'missing task' || name === 'invalid history') {
      const c = f.repo.commit({
        'proof.yaml':
          name === 'missing task' ? '{"version":1,"project":"carry","tasks":{}}' : 'invalid',
      });
      f.query('UPDATE results SET "commit" = ?', c);
    }
    f.update(files);
    const before = f.query('SELECT * FROM proofs');
    const r = f.cli(['rekey', '--apply']);
    expect(r.out, name).toContain(`${reason}: 1`);
    if (reason === 'declarations unavailable') expect(r.err).toContain('declarations unavailable');
    expect(f.query('SELECT * FROM proofs'), name).toEqual(before);
    expect(f.plan().state, name).toBe('RUN');
  }
}, 30_000);

test('narrowing, frozen projection members and literal brackets carry from the original result', () => {
  for (const scenario of ['narrow', 'projection', 'brackets', 'newest']) {
    const f = fixture(
      undefined,
      scenario === 'projection' ? [{ path: 'data.json', json: ['chosen'] }] : ['a', 'c'],
    );
    if (scenario === 'newest') {
      f.repo.commit({ a: 'different' });
      f.cli(['record', 'journey', '--outcome', 'green']);
    }
    const source = f.repo.git('rev-parse', 'HEAD');
    const t = f.doc.tasks.journey;
    if (scenario === 'narrow' || scenario === 'newest') t.inputs = ['a'];
    if (scenario === 'projection') {
      t.inputs = [{ path: 'data.json', json: ['chosen'] }, 'b'];
      f.repo.write('data.json', '{"chosen":1,"other":2}');
    }
    if (scenario === 'brackets') {
      t.inputs = ['a', { path: '[id].json', json: ['chosen'] }];
    }
    f.update();
    const r = f.cli(['rekey', '--apply']);
    expect(r.out).toContain('local: carried 1');
    expect(r.out).toContain(source);
    expect(f.plan().state).toBe('PROVEN');
    t.inputs = [...(t.inputs as unknown[]), 'package.json'];
    f.update();
    expect(f.cli(['rekey', '--apply']).out).toContain('local: carried 1');
    expect(f.plan().state).toBe('PROVEN');
  }
}, 15_000);

test('source contests, destination vetoes and remote-only unshared reds block publication', async () => {
  for (const kind of ['source', 'red', 'manual', 'unshared']) {
    const remote = await pg.database();
    const f = fixture(remote.PROOF_STORE);
    const source = f.plan().key;
    if (kind === 'source')
      f.query("INSERT INTO observed_contests SELECT result_id, 'red', 'host' FROM proofs");
    if (kind === 'unshared') {
      f.query('DELETE FROM proofs');
      f.query('INSERT INTO unshared_reds SELECT project, task, key, id FROM results');
    }
    f.doc.tasks.journey.inputs = ['a', 'b'];
    f.update();
    if (kind === 'red') f.cli(['record', 'journey', '--outcome', 'red']);
    if (kind === 'manual') {
      f.cli(['record', 'journey', '--outcome', 'green']);
      f.cli(['invalidate', '--task', 'journey', '--key', f.plan().key]);
    }
    const r = f.cli(['rekey', '--apply']);
    expect(r.out, kind).toContain(
      kind === 'source' || kind === 'unshared' ? 'contested: 1' : 'destination rejected: 1',
    );
    expect(f.plan().state).toBe('RUN');
    expect(await remote.sql`SELECT * FROM proofs WHERE key != ${source}`).toHaveLength(0);
  }
}, 30_000);

test('generated historical declarations are shared by tasks and backends and retain the generator cache', async () => {
  const remote = await pg.database();
  const f = fixture(remote.PROOF_STORE);
  const root = {
    version: 1,
    project: 'carry',
    generate: {
      run: 'bun generator.js',
      inputs: ['generator.js', 'version'],
      links: ['trace'],
    },
  };
  const generator = `import {appendFileSync} from 'node:fs';
const version = await Bun.file('version').text();
appendFileSync('trace/runs', version + '\\n');
const task = {run:'true', carry:true, inputs:version === 'old' ? ['a'] : ['a','b']};
await Bun.write(process.env.PROOF_DECLARATIONS + '/tasks.yaml', JSON.stringify({tasks:{one:task,two:task}}));`;
  f.repo.write('trace/runs', '');
  f.repo.commit({
    '.gitignore': 'trace/\n',
    'proof.yaml': JSON.stringify(root),
    'generator.js': generator,
    version: 'old',
  });
  for (const task of ['one', 'two']) f.cli(['record', task, '--outcome', 'green']);
  const c = f.repo.git('rev-parse', 'HEAD');
  f.repo.commit({ version: 'new' });
  rmSync(join(f.env.PROOF_STATE_DIR, 'generated'), { recursive: true });
  f.repo.write('trace/runs', '');
  const r = f.cli(['rekey', '--apply']);
  expect(r.out).toContain('local: carried 2');
  expect(r.out).toContain('shared: carried 2');
  expect(r.out).toContain(c);
  expect(r.out.match(/added input b/g)).toHaveLength(4);
  expect(readFileSync(join(f.repo.path, 'trace/runs'), 'utf8')).toBe('new\nold\n');
  f.cli(['rekey']);
  expect(readFileSync(join(f.repo.path, 'trace/runs'), 'utf8')).toBe('new\nold\n');
  const rows = JSON.parse(f.cli(['plan', '--json']).out);
  expect(rows.every((row: { state: string }) => row.state === 'PROVEN')).toBe(true);
  f.repo.commit({
    'generator.js': generator.replace("run:'true'", "run:version === 'old' ? 'true' : 'false'"),
    version: 'newer',
  });
  expect(f.cli(['rekey', '--apply']).out).toContain('declaration differs: 2');
}, 30_000);

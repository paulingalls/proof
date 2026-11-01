import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider, Task } from '../src/declarations';
import { Postgres } from './support/postgres';
import { Repo } from './support/repo';

const pg = new Postgres();
const repos: Repo[] = [];
const dirs: string[] = [];
beforeAll(() => pg.start(), 120_000);
afterAll(() => pg.close());
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'proof-provider-env-'));
  dirs.push(path);
  return path;
}
function fixture(source?: Repo) {
  const repo = new Repo(source);
  repos.push(repo);
  const control = directory();
  const env = { PROOF_STATE_DIR: directory(), TMPDIR: directory(), CONTROL: control, ADDRESS: '' };
  const task = (name: string, needs = ['stack']): Task => ({
    run: `${process.execPath} observe.ts '${control}' ${name}`,
    inputs: ['observe.ts'],
    needs,
  });
  const mark = (name: string) => `echo ${name} >> '${control}/events'`;
  const start = `${process.execPath} start.ts`;
  const commit = (
    tasks: Record<string, Task>,
    providers: Record<string, Provider> = {
      stack: { start, stop: mark('stop') },
    },
  ) =>
    repo.commit({
      'proof.yaml': JSON.stringify({ version: 1, project: 'provider-env', providers, tasks }),
      'start.ts': `import { statSync, writeFileSync, appendFileSync } from 'node:fs';
const path = process.env.PROOF_PROVIDER_ENV;
if (path) {
  if ((statSync(path).mode & 0o777) !== 0o600) process.exit(9);
  if (!path.startsWith(process.env.PROOF_STATE_DIR + '/')) process.exit(10);
  writeFileSync(process.env.CONTROL + '/channel', path);
  writeFileSync(path, 'URL=' + process.env.ADDRESS + '\\n');
}
appendFileSync(process.env.CONTROL + '/events', 'start\\n');`,
      'observe.ts': `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const [control, name] = process.argv.slice(2);
if (process.env.PROOF_PROVIDER_ENV !== undefined) process.exit(11);
if (name.startsWith('independent')) {
  if (process.env.URL !== undefined) process.exit(12);
} else {
  if (process.env.URL !== readFileSync(control + '/expected', 'utf8')) process.exit(13);
  if (existsSync(readFileSync(control + '/channel', 'utf8'))) process.exit(14);
  writeFileSync(control + '/' + name, process.env.URL);
}`,
    });
  const address = (value = `private_${crypto.randomUUID()}`) => {
    env.ADDRESS = value;
    writeFileSync(join(control, 'expected'), value);
    return value;
  };
  const cli = (...args: string[]) => repo.cli(args, env);
  const rows = () => {
    const db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
    try {
      return db.query('SELECT * FROM results ORDER BY rowid').all() as {
        key: string;
        outcome: string;
        task: string;
      }[];
    } finally {
      db.close();
    }
  };
  const clean = (result: { out: string; err: string }, value: string) => {
    expect(result.out + result.err).not.toContain(value);
    for (const file of readdirSync(env.PROOF_STATE_DIR, { recursive: true, withFileTypes: true })) {
      if (file.isFile())
        expect(readFileSync(join(file.parentPath, file.name)).includes(value)).toBe(false);
    }
    if (existsSync(join(control, 'channel')))
      expect(existsSync(readFileSync(join(control, 'channel'), 'utf8'))).toBe(false);
  };
  return { repo, control, env, task, mark, start, commit, address, cli, rows, clean };
}

for (const jobs of ['1', '2']) {
  test(`delivers privately to concurrent dependents, independent tasks stay isolated (jobs ${jobs})`, () => {
    const f = fixture();
    f.commit({
      first: f.task('first'),
      second: f.task('second'),
      independent: f.task('independent', []),
      after: f.task('independent-after', []),
    });
    for (let run = 0; run < 2; run++) {
      const value = f.address();
      const result = f.repo.cli(['run', '--fresh', '--jobs', jobs], { ...f.env, URL: 'caller' });
      expect(result.code).toBe(0);
      for (const name of ['first', 'second'])
        expect(readFileSync(join(f.control, name), 'utf8')).toBe(value);
      f.clean(result, value);
    }
    expect(new Set(f.rows().map((r) => r.key)).size).toBe(4);
    expect(readFileSync(join(f.control, 'events'), 'utf8')).toBe('start\nstop\nstart\nstop\n');
  });
}

test('different provider addresses share one proof across clones', async () => {
  const db = await pg.database();
  const a = fixture();
  a.commit({ gate: a.task('gate') });
  const b = fixture(a.repo);
  // The cloned task's control path stays identical, as do its declaration and key.
  const first = a.address();
  const result = a.repo.cli(['run'], { ...a.env, PROOF_STORE: db.PROOF_STORE });
  expect(result.code).toBe(0);
  a.clean(result, first);
  const second = b.address();
  writeFileSync(join(a.control, 'expected'), second);
  const proven = b.repo.cli(['run'], { ...b.env, PROOF_STORE: db.PROOF_STORE });
  expect(proven.code).toBe(0);
  expect(proven.out).toContain('PROVEN gate');
  expect(existsSync(join(b.control, 'events'))).toBe(false);
  const fresh = b.repo.cli(['run', '--fresh'], {
    ...b.env,
    CONTROL: a.control,
    PROOF_STORE: db.PROOF_STORE,
  });
  expect(fresh.code).toBe(0);
  expect(readFileSync(join(a.control, 'gate'), 'utf8')).toBe(second);
  expect(a.rows()[0]?.key).toBe(b.rows()[0]?.key);
  b.clean(fresh, second);
  for (const table of ['results', 'proofs', 'contradictions']) {
    const rows = await db.sql.unsafe(`SELECT row_to_json(t) FROM ${table} t`);
    expect(JSON.stringify(rows)).not.toContain(first);
    expect(JSON.stringify(rows)).not.toContain(second);
  }
});

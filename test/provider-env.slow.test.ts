import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Provider, Task } from '../src/declarations';
import { output, Postgres, waitFor } from './support/postgres';
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
  if ((statSync(path).mode & 0o777) !== 0o600 ||
      (statSync(require('node:path').dirname(path)).mode & 0o777) !== 0o700) process.exit(9);
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
  const rows = (table = 'results') => {
    const db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
    try {
      return db.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as {
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
    if (existsSync(join(control, 'channel'))) {
      const path = readFileSync(join(control, 'channel'), 'utf8');
      expect(existsSync(path)).toBe(false);
      expect(existsSync(dirname(path))).toBe(false);
    }
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
  a.clean(fresh, second);
  const tables = await db.sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
  for (const { tablename: table } of tables) {
    const rows = await db.sql.unsafe(`SELECT row_to_json(t) FROM ${table} t`);
    expect(JSON.stringify(rows)).not.toContain(first);
    expect(JSON.stringify(rows)).not.toContain(second);
  }
});

for (const kind of [
  'bare',
  'invalid',
  'nul',
  'blank',
  'duplicate',
  'PATH',
  'HOME',
  'TMPDIR',
  'PROOF_PROVIDER_ENV',
  'declared',
  'declared-later',
  'edited',
  'missing',
]) {
  test(`rejects ${kind} exports without publishing values or executing dependents`, () => {
    const f = fixture();
    const value = f.address();
    const tasks = {
      first: { ...f.task('first'), run: f.mark('ran-dependent') },
      later: { ...f.task('later'), env: kind.startsWith('declared') ? ['URL'] : [] },
      independent: { ...f.task('independent', []), run: f.mark('independent') },
    };
    const payload =
      kind === 'bare'
        ? value.replaceAll('-', '_')
        : kind === 'invalid'
          ? `${value}-=hidden`
          : kind === 'nul'
            ? `URL=${value}\0`
            : kind === 'blank'
              ? `URL=${value}\n\n`
              : kind === 'duplicate'
                ? `URL=${value}\nURL=${value}`
                : `${kind.startsWith('declared') || kind === 'edited' || kind === 'missing' ? 'URL' : kind}=${value}`;
    const write =
      kind === 'missing'
        ? 'rm "$PROOF_PROVIDER_ENV"'
        : `${process.execPath} -e 'require("fs").writeFileSync(process.env.PROOF_PROVIDER_ENV, Buffer.from(process.env.PAYLOAD, "base64"))'`;
    const edit =
      kind === 'edited'
        ? `${process.execPath} -e 'const f=require("fs"); const d=JSON.parse(f.readFileSync("proof.yaml", "utf8")); d.tasks.later.env=["URL"]; f.writeFileSync("proof.yaml", JSON.stringify(d))'`
        : 'true';
    f.commit(tasks, {
      stack: {
        start: `${f.start}; if [ -n "$PROOF_PROVIDER_ENV" ]; then ${write}; fi; ${edit}`,
        stop: f.mark('stop'),
      },
    });
    const result = f.repo.cli(
      [
        'run',
        '--jobs',
        '2',
        '--tasks',
        'first',
        'independent',
        ...(kind === 'declared-later' ? ['later'] : []),
      ],
      {
        ...f.env,
        PAYLOAD: Buffer.from(payload).toString('base64'),
        URL: 'declared-caller',
      },
    );
    expect(result.code).toBe(1);
    expect(result.out).toContain("provider 'stack' start failed");
    expect(result.out).toContain(
      ['bare', 'invalid'].includes(kind)
        ? 'line 1: invalid name'
        : kind === 'missing'
          ? 'cannot read environment channel'
          : kind === 'blank'
            ? 'line 2'
            : kind === 'duplicate' ||
                kind === 'nul' ||
                kind.startsWith('declared') ||
                kind === 'edited'
              ? "'URL'"
              : `'${kind}'`,
    );
    expect(readFileSync(join(f.control, 'events'), 'utf8')).not.toContain('ran-dependent');
    expect(readFileSync(join(f.control, 'events'), 'utf8')).toContain('independent');
    expect(readFileSync(join(f.control, 'events'), 'utf8')).toContain('stop');
    if (kind !== 'edited')
      expect(f.rows().find((r) => r.task === 'first')?.outcome).toBe('incomplete');
    expect(f.rows('proofs').some((r) => r.task === 'first')).toBe(false);
    f.clean(result, kind === 'bare' ? payload : value);
  });
}

test('disjoint providers may export the same name; a common dependent rejects even equal values', () => {
  for (const common of [false, true]) {
    const f = fixture();
    const value = f.address();
    const other = directory();
    const otherValue = common ? value : `other_${crypto.randomUUID()}`;
    writeFileSync(join(other, 'expected'), otherValue);
    f.commit(
      {
        first: f.task('first'),
        second: {
          ...f.task('second', ['other']),
          run: f.task('second').run.replace(f.control, other),
        },
        ...(common
          ? { common: { ...f.task('common', ['stack', 'other']), run: f.mark('common') } }
          : {}),
      },
      {
        stack: { start: f.start, stop: f.mark('stop-stack') },
        other: {
          start: `CONTROL='${other}' ADDRESS="$OTHER_ADDRESS" ${f.start}`,
          stop: f.mark('stop-other'),
        },
      },
    );
    const result = f.repo.cli(['run', '--jobs', '2'], { ...f.env, OTHER_ADDRESS: otherValue });
    expect(result.code).toBe(common ? 1 : 0);
    if (common) {
      expect(result.out).toContain("'URL': conflicts with provider");
      expect(f.rows().find((r) => r.task === 'common')?.outcome).toBe('incomplete');
    } else {
      expect(readFileSync(join(f.control, 'first'), 'utf8')).toBe(value);
      expect(readFileSync(join(other, 'second'), 'utf8')).toBe(otherValue);
    }
    f.clean(result, value);
  }
});

test('literal values and shell-shaped names are delivered without evaluation', () => {
  const f = fixture();
  const value = f.address(' spaces=$HOME="literal"\r');
  f.commit(
    {
      gate: {
        ...f.task('gate'),
        run: `${process.execPath} -e 'if (process.env.__proto__ !== "ok" || process.env.EMPTY !== "") process.exit(1)' && ${f.task('gate').run}`,
      },
    },
    {
      stack: { start: `${f.start}; printf '__proto__=ok\nEMPTY=\n' >> "$PROOF_PROVIDER_ENV"` },
    },
  );
  const result = f.cli('run');
  expect(result.code).toBe(0);
  f.clean(result, value);
});

for (const interrupted of [false, true]) {
  test(`cleans private channel after ${interrupted ? 'SIGTERM' : 'nonzero start'}`, async () => {
    const f = fixture();
    const value = f.address();
    f.commit(
      { gate: f.task('gate') },
      {
        stack: {
          start: `${f.start}; ${interrupted ? 'touch "$CONTROL/waiting"; exec sleep 30' : 'exit 1'}`,
          stop: f.mark('stop'),
        },
      },
    );
    const child = f.repo.spawnCli(['run'], f.env);
    const resultPromise = output(child);
    if (interrupted) {
      await waitFor(async () => existsSync(join(f.control, 'waiting')));
      child.kill('SIGTERM');
    }
    const result = await resultPromise;
    expect(result.code).toBe(interrupted ? 143 : 1);
    expect(f.rows()[0]?.outcome).toBe('incomplete');
    expect(readFileSync(join(f.control, 'events'), 'utf8')).toContain('stop');
    f.clean(result, value);
  });
}

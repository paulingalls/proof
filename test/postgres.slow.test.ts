import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { output, Postgres, waitFor } from './support/postgres';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const paths: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'proof-postgres-'));
  paths.push(path);
  return path;
}
function fixture(project = 'example') {
  const repo = Repo.from(`postgres:${project}`, (template) =>
    template.commit({
      'proof.yaml': JSON.stringify({
        version: 1,
        project,
        tasks: { lint: { run: 'echo postgres-task-marker', inputs: ['src/**'] } },
      }),
      'src/a.ts': 'a',
    }),
  );
  repos.push(repo);
  return repo;
}
const commands = [['plan'], ['record', 'lint', '--outcome', 'green'], ['run']];

test('present invalid store configuration fails naming its source, never its value', () => {
  const repo = fixture();
  const base = directory();
  for (const value of [
    '',
    'secret-invalid',
    'sqlite://secret',
    'postgres://',
    'postgres://host:99999',
  ]) {
    for (const source of ['env', 'xdg', 'home']) {
      mkdirSync(join(base, 'proof'), { recursive: true });
      mkdirSync(join(base, '.config/proof'), { recursive: true });
      writeFileSync(join(base, 'proof/store'), `${value}\r\nignored`);
      writeFileSync(join(base, '.config/proof/store'), `${value}\nignored`);
      const env = {
        PROOF_STATE_DIR: directory(),
        ...(source === 'env'
          ? { PROOF_STORE: value }
          : source === 'xdg'
            ? { XDG_CONFIG_HOME: base }
            : { HOME: base }),
      };
      for (const args of commands) {
        const result = repo.cli(args, env);
        expect(result.code).toBe(2);
        expect(result.err).toContain(source === 'env' ? 'PROOF_STORE' : 'proof/store');
        if (value) expect(result.err).not.toContain(value);
        expect(result.out).not.toContain('postgres-task-marker');
      }
    }
  }
}, 30_000);

test('invalid environment overrides the file and unreadable configuration fails loudly', () => {
  const repo = fixture();
  const base = directory();
  mkdirSync(join(base, 'proof'), { recursive: true });
  writeFileSync(join(base, 'proof/store'), 'postgres://localhost/example');
  const result = repo.cli(['plan'], {
    PROOF_STATE_DIR: directory(),
    XDG_CONFIG_HOME: base,
    PROOF_STORE: '',
  });
  expect(result.code).toBe(2);
  expect(result.err).toContain('PROOF_STORE');
  rmSync(join(base, 'proof/store'));
  mkdirSync(join(base, 'proof/store'));
  const unreadable = repo.cli(['plan'], { PROOF_STATE_DIR: directory(), XDG_CONFIG_HOME: base });
  expect(unreadable.code).toBe(2);
  expect(unreadable.err).toContain('proof/store');
});

test('the executable does not load store configuration from the repository', () => {
  const repo = fixture();
  repo.write('.env', 'PROOF_STORE=not-a-url\n');
  const result = Bun.spawnSync([new URL('../src/cli.ts', import.meta.url).pathname, 'plan'], {
    cwd: repo.path,
    env: { PATH: process.env.PATH, PROOF_STATE_DIR: directory() },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain('RUN lint');
});

let postgres: Postgres;
beforeAll(async () => {
  postgres = await new Postgres().start();
}, 180_000);
afterAll(async () => {
  await postgres?.close();
}, 30_000);

test('owned scope removes its container even when the scope throws', async () => {
  const owned = await new Postgres().start();
  try {
    await expect(
      (async () => {
        try {
          throw new Error('scope failed');
        } finally {
          await owned.close();
        }
      })(),
    ).rejects.toThrow('scope failed');
    owned.assertAbsent();
  } finally {
    await owned.close();
  }
}, 180_000);

async function setup() {
  const repo = fixture();
  const { PROOF_STORE, sql } = await postgres.database();
  const env = { PROOF_STORE, PROOF_STATE_DIR: directory() };
  const record = (outcome: string, target = repo) => {
    const result = target.cli(
      ['record', 'lint', '--outcome', outcome, '--seconds', '1.1234567890123'],
      env,
    );
    expect(result.code).toBe(0);
    return result;
  };
  const plan = (expected: string, target = repo) => {
    const result = target.cli(['plan'], env);
    expect(result.code).toBe(0);
    expect(result.out).toContain(expected);
  };
  return { repo, env, sql, record, plan };
}

test('remote green is reused across clones with provenance, precise duration and project scope', async () => {
  const { repo, env, sql, record, plan } = await setup();
  plan('RUN lint');
  await sql`SELECT setval(pg_get_serial_sequence('results', 'id'), 9007199254740993, false)`;
  record('green');
  const clone = new Repo(repo);
  repos.push(clone);
  plan(`PROVEN lint: proven at ${repo.git('rev-parse', 'HEAD')} on ${hostname()}`, clone);
  plan('RUN lint: no proof', fixture('other'));
  expect(await sql`SELECT outcome, seconds, dirty FROM results`).toEqual([
    { outcome: 'green', seconds: 1.1234567890123, dirty: 0 },
  ]);
  expect((await sql`SELECT result_id FROM proofs`)[0].result_id).toBe('9007199254740993');
  const base = directory();
  mkdirSync(join(base, 'proof'));
  writeFileSync(
    join(base, 'proof/store'),
    `${env.PROOF_STORE.replace('postgres:', 'postgresql:')}\r\nignored`,
  );
  expect(
    clone.cli(['plan'], { XDG_CONFIG_HOME: base, PROOF_STATE_DIR: directory() }).out,
  ).toContain('PROVEN lint');
  writeFileSync(join(base, 'proof/store'), 'invalid');
  expect(clone.cli(['plan'], { ...env, XDG_CONFIG_HOME: base }).out).toContain('PROVEN lint');
  expect(
    clone.cli(['plan'], {
      PROOF_STORE: env.PROOF_STORE.replace('postgres:', 'postgresql:'),
      PROOF_STATE_DIR: directory(),
    }).out,
  ).toContain('PROVEN lint');
}, 30_000);

test('contested transitions retain the same contradiction anchors and incomplete contests nothing', async () => {
  const { sql, record, plan } = await setup();
  record('green');
  record('incomplete');
  plan('PROVEN lint');
  record('red');
  plan('contested:');
  record('incomplete');
  plan('contested:');
  record('green');
  plan('PROVEN lint');
  record('red');
  plan('contested:');
  record('red');
  plan('RUN lint: no proof');
  const results = await sql`SELECT id, outcome FROM results ORDER BY id`;
  const contradictions =
    await sql`SELECT green_result, red_result, kind, deleted_proof FROM contradictions ORDER BY id`;
  expect(contradictions).toEqual([
    { green_result: results[0].id, red_result: results[2].id, kind: 'ordinary', deleted_proof: 0 },
    { green_result: results[4].id, red_result: results[5].id, kind: 'ordinary', deleted_proof: 0 },
    { green_result: results[4].id, red_result: results[6].id, kind: 'ordinary', deleted_proof: 1 },
  ]);
  expect(await sql`SELECT * FROM proofs`).toHaveLength(0);
}, 30_000);

test('dirty green stores history only; dirty-input red cannot contest but unrelated dirtiness can', async () => {
  const { repo, sql, record, plan } = await setup();
  repo.write('src/a.ts', 'dirty');
  expect(record('green').out).toContain('no proof published');
  expect(await sql`SELECT * FROM proofs`).toHaveLength(0);
  repo.git('restore', '.');
  record('green');
  repo.write('src/a.ts', 'dirty');
  expect(record('red').out).toContain('contests nothing');
  expect(await sql`SELECT * FROM contradictions`).toHaveLength(0);
  repo.git('restore', '.');
  plan('PROVEN lint');
  repo.write('notes.md', 'dirty');
  record('red');
  plan('contested:');
  expect(
    (await sql`SELECT dirty FROM results ORDER BY id`).map((r: { dirty: number }) => r.dirty),
  ).toEqual([1, 0, 1, 1]);
}, 30_000);

test('run publishes remotely and a second clone skips without executing', async () => {
  const { repo, env, sql } = await setup();
  const first = repo.cli(['run'], env);
  expect(first.code).toBe(0);
  expect(first.out).toContain('postgres-task-marker');
  const clone = new Repo(repo);
  repos.push(clone);
  const second = clone.cli(['run'], { ...env, PROOF_STATE_DIR: directory() });
  expect(second.code).toBe(0);
  expect(second.out).toContain('PROVEN lint');
  expect(second.out).not.toContain('postgres-task-marker');
  expect(await sql`SELECT outcome FROM results`).toEqual([{ outcome: 'green' }]);
}, 30_000);

for (const table of ['proofs', 'contradictions']) {
  test(`a failing ${table} update rolls back the result and retains the original proof`, async () => {
    const { repo, env, sql, record, plan } = await setup();
    record('green');
    const before = await sql`SELECT * FROM proofs`;
    await sql.unsafe(`CREATE FUNCTION reject_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected update failure'; END $$;
      CREATE TRIGGER reject_write BEFORE INSERT OR UPDATE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION reject_write()`);
    const result = repo.cli(
      ['record', 'lint', '--outcome', table === 'proofs' ? 'green' : 'red'],
      env,
    );
    expect(result.code).toBe(2);
    expect(result.err).toContain('injected update failure');
    expect(await sql`SELECT outcome FROM results`).toEqual([{ outcome: 'green' }]);
    expect(await sql`SELECT * FROM proofs`).toEqual(before);
    expect(await sql`SELECT * FROM contradictions`).toHaveLength(0);
    plan(table === 'proofs' ? 'PROVEN lint' : 'RUN lint: contested:');
    const shared = repo.cli(['plan'], { ...env, PROOF_STATE_DIR: directory() });
    expect(shared.code).toBe(0);
    expect(shared.out).toContain('PROVEN lint');
  }, 30_000);
}

test('a reader never observes an inserted result before its proof update commits', async () => {
  const { repo, env, sql } = await setup();
  expect(repo.cli(['plan'], env).code).toBe(0);
  await sql.unsafe(`CREATE FUNCTION block_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(123456); RETURN NEW; END $$;
    CREATE TRIGGER block_write BEFORE INSERT ON proofs FOR EACH ROW EXECUTE FUNCTION block_write()`);
  const locker = postgres.connect(env.PROOF_STORE);
  await locker`SELECT pg_advisory_lock(123456)`;
  const child = repo.spawnCli(['record', 'lint', '--outcome', 'green'], env);
  const done = output(child);
  try {
    await waitFor(
      async () =>
        (await sql`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`).length ===
        1,
    );
    expect(await sql`SELECT * FROM results`).toHaveLength(0);
    expect(await sql`SELECT * FROM proofs`).toHaveLength(0);
  } finally {
    await locker`SELECT pg_advisory_unlock(123456)`;
  }
  expect((await done).code).toBe(0);
  expect(await sql`SELECT * FROM results`).toHaveLength(1);
  expect(await sql`SELECT * FROM proofs`).toHaveLength(1);
}, 30_000);

for (const backend of ['postgres', 'sqlite']) {
  test(`${backend} refuses newer schemas for plan, record and run without modifying history`, async () => {
    const repo = fixture();
    const remote = backend === 'postgres' ? await postgres.database() : undefined;
    const localPath = directory();
    const env = {
      PROOF_STATE_DIR: localPath,
      ...(remote ? { PROOF_STORE: remote.PROOF_STORE } : {}),
    };
    expect(repo.cli(['record', 'lint', '--outcome', 'green'], env).code).toBe(0);
    const local = remote ? undefined : new Database(join(localPath, 'proof.db'));
    try {
      if (remote) await remote.sql`UPDATE schema_version SET version = 2`;
      else local?.exec('UPDATE schema_version SET version = 2');
      for (const args of commands) {
        const result = repo.cli(args, env);
        expect(result.code).toBe(2);
        expect(result.err).toContain('store schema version 2; supported version 1');
        expect(result.out).not.toContain('postgres-task-marker');
      }
      const versions = remote
        ? await remote.sql`SELECT version FROM schema_version`
        : local?.query('SELECT version FROM schema_version').all();
      expect(versions).toEqual([{ version: 2 }]);
      const rows = remote
        ? await remote.sql`SELECT outcome FROM results`
        : local?.query('SELECT outcome FROM results').all();
      expect(rows).toEqual([{ outcome: 'green' }]);
    } finally {
      local?.close();
    }
  }, 30_000);
}

test('an unversioned SQLite history is adopted without losing its proof', () => {
  const repo = fixture();
  const env = { PROOF_STATE_DIR: directory() };
  expect(repo.cli(['record', 'lint', '--outcome', 'green'], env).code).toBe(0);
  const db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
  try {
    db.exec('DROP TABLE IF EXISTS schema_version');
    expect(repo.cli(['plan'], env).out).toContain('PROVEN lint');
    expect(db.query('SELECT version FROM schema_version').all()).toEqual([{ version: 1 }]);
    expect(db.query('SELECT outcome FROM results').all()).toEqual([{ outcome: 'green' }]);
  } finally {
    db.close();
  }
});

for (const outcome of ['green', 'red', 'initialize']) {
  test(`overlapping ${outcome} writers serialize even without an existing proof`, async () => {
    const { repo, env, sql, record, plan } = await setup();
    if (outcome !== 'initialize') plan('RUN lint');
    if (outcome === 'red') {
      const [database] = await sql`SELECT current_database() AS name`;
      await sql.unsafe(
        `ALTER DATABASE ${database.name} SET default_transaction_isolation TO 'repeatable read'`,
      );
      record('green');
    }
    const localEnv = { PROOF_STATE_DIR: directory() };
    expect(repo.cli(['record', 'lint', '--outcome', 'incomplete'], localEnv).code).toBe(0);
    const local = new Database(join(localEnv.PROOF_STATE_DIR, 'proof.db'));
    const row = local.query<{ key: string }, []>('SELECT key FROM results').get();
    if (!row) throw new Error('missing recorded key');
    local.close();
    const lock =
      outcome === 'initialize' ? 'proof:schema' : JSON.stringify(['example', 'lint', row.key]);
    const locker = postgres.connect(env.PROOF_STORE);
    await locker`SELECT pg_advisory_lock(hashtextextended(${lock}, 0))`;
    const children = [0, 1].map(() =>
      repo.spawnCli(['record', 'lint', '--outcome', outcome === 'red' ? 'red' : 'green'], env),
    );
    const done = children.map(output);
    try {
      await waitFor(
        async () =>
          (await sql`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`).length ===
          2,
      );
    } finally {
      await locker`SELECT pg_advisory_unlock(hashtextextended(${lock}, 0))`;
      const results = await Promise.all(done);
      for (const result of results) expect(result.code).toBe(0);
    }
    expect(await sql`SELECT * FROM schema_version`).toHaveLength(1);
    const results = await sql`SELECT id, outcome FROM results ORDER BY id`;
    expect(results).toHaveLength(outcome === 'red' ? 3 : 2);
    expect(await sql`SELECT * FROM proofs`).toHaveLength(outcome === 'red' ? 0 : 1);
    if (outcome === 'red') {
      const rows =
        await sql`SELECT green_result, red_result, deleted_proof FROM contradictions ORDER BY id`;
      expect(rows).toEqual([
        { green_result: results[0].id, red_result: results[1].id, deleted_proof: 0 },
        { green_result: results[0].id, red_result: results[2].id, deleted_proof: 1 },
      ]);
      plan('RUN lint: no proof');
    } else expect(results.map((r: { outcome: string }) => r.outcome)).toEqual(['green', 'green']);
  }, 30_000);
}

test('interrupting a blocked proof read does not start the task', async () => {
  const { repo, env, sql } = await setup();
  expect(repo.cli(['plan'], env).code).toBe(0);
  const locker = postgres.connect(env.PROOF_STORE);
  await locker`BEGIN`;
  await locker`LOCK TABLE proofs IN ACCESS EXCLUSIVE MODE`;
  const child = repo.spawnCli(['run'], env);
  const done = output(child);
  try {
    await waitFor(
      async () =>
        (await sql`SELECT 1 FROM pg_locks WHERE relation = 'proofs'::regclass AND NOT granted`)
          .length === 1,
    );
    child.kill('SIGINT');
    await Bun.sleep(30);
  } finally {
    await locker`COMMIT`;
  }
  const result = await done;
  expect(result.code).toBe(130);
  expect(result.out).not.toContain('postgres-task-marker');
  expect(await sql`SELECT * FROM results`).toHaveLength(0);
}, 30_000);

test('failed connections name the redacted store without leaking any password', async () => {
  const repo = fixture();
  const endpoint = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data() {},
      open(socket) {
        socket.end();
      },
    },
  });
  const port = endpoint.port;
  endpoint.stop(true);
  for (const kind of ['auth', 'query', 'query case', 'unencoded', 'refused']) {
    const url = new URL(postgres.url);
    const secret = 'distinctive:p@ss/word';
    url.password = encodeURIComponent(secret);
    if (kind === 'query') {
      url.password = '';
      url.searchParams.set('password', secret);
    }
    if (kind === 'query case') url.searchParams.set('PASSWORD', secret);
    if (kind === 'refused') url.port = String(port);
    const store = kind === 'unencoded' ? 'postgres://proof:1/distinctive@127.0.0.1/db' : url.href;
    const expected = kind === 'unencoded' ? 'proof:1' : `${url.hostname}:${url.port}`;
    for (const args of commands) {
      const result = repo.cli(args, { PROOF_STORE: store, PROOF_STATE_DIR: directory() });
      expect(result.code).toBe(['refused', 'unencoded'].includes(kind) ? 0 : 2);
      expect(result.err).toContain(expected);
      expect(result.err).toContain('postgres://');
      for (const value of [secret, encodeURIComponent(secret), 'distinctive']) {
        expect(result.err + result.out).not.toContain(value);
      }
    }
  }
}, 60_000);

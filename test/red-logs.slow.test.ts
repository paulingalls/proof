import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fixture, spawn, stop, task, until, wait } from './support/jobs';
import { Postgres } from './support/postgres';

function logPath(out: string, id: string, outcome = 'red') {
  const line = out
    .split('\n')
    .find((line) => line.startsWith(`${outcome} ${id};`) && line.includes('; log: '));
  expect(line).toBeDefined();
  const path = line?.split('; log: ')[1];
  if (!path) throw new Error(`missing log path: ${out}`);
  expect(isAbsolute(path)).toBe(true);
  expect(path).toMatch(new RegExp(`-${outcome}\\.log$`));
  return path;
}

test('red bytes survive sandbox and worktree removal; green leaves no file', () => {
  const f = fixture({
    red: {
      run: 'printf "out\\n"; printf "err\\n" >&2; pwd; printf tail; exit 1',
      inputs: ['input'],
    },
    green: { run: 'echo green-output', inputs: ['input'] },
  });
  const worktree = join(f.directory(), 'checkout');
  f.repo.git('worktree', 'add', '--detach', worktree, 'HEAD');
  const result = f.repo.cli(['run'], f.env, worktree);
  expect(result.code, result.err).toBe(1);
  expect(result.err).toBe('');
  const path = logPath(result.out, 'red');
  expect(path.startsWith(`${f.env.PROOF_STATE_DIR}/logs/jobs/tasks/red/`)).toBe(true);
  expect(path).toContain(`-${f.rows()[0]?.key.slice(0, 8)}-red.log`);
  const bytes = readFileSync(path, 'utf8');
  const sandbox = bytes.split('\n')[2] as string;
  expect(bytes).toBe(`out\nerr\n${sandbox}\ntail`);
  expect(result.out.split(bytes)).toHaveLength(2);
  expect(existsSync(sandbox)).toBe(false);
  expect(existsSync(join(f.env.PROOF_STATE_DIR, 'logs/jobs/tasks/green'))).toBe(false);
  expect(f.rows().map((r) => r.outcome)).toEqual(['red', 'green']);
  f.repo.git('worktree', 'remove', '--force', worktree);
  expect(readFileSync(path, 'utf8')).toBe(bytes);
});

test('serial stdout and stderr arrive live exactly once', async () => {
  const f = fixture({ a: task(`echo live-out; echo live-err >&2; ${wait('release')}`) });
  const child = f.repo.spawnCli(['run'], f.env);
  let out = '';
  const reading = (async () => {
    for await (const chunk of child.stdout) out += Buffer.from(chunk).toString();
  })();
  const err = new Response(child.stderr).text();
  try {
    await until(() => out.includes('live-out\n') && out.includes('live-err\n'));
    f.mark('release');
    expect(await child.exited).toBe(0);
    await reading;
    expect(await err).toBe('');
    for (const marker of ['live-out\n', 'live-err\n']) expect(out.split(marker)).toHaveLength(2);
  } finally {
    f.mark('release');
    await stop(child);
    await reading;
  }
}, 15000);

test('SIGTERM reaches a task while the live tail is behind a slow stdout', async () => {
  const f = fixture({
    a: task(
      `trap 'touch scratch/stopped; exit 0' TERM; touch scratch/started; i=0; while [ $i -lt 500000 ]; do echo ${'x'.repeat(99)}; i=$((i+1)); done`,
    ),
  });
  const child = f.repo.spawnCli(['run'], f.env);
  const reader = child.stdout.getReader();
  const reading = (async () => {
    while (!(await reader.read()).done) if (!f.has('stopped')) await Bun.sleep(200);
  })();
  try {
    await until(() => f.has('started'));
    await Bun.sleep(200);
    child.kill('SIGTERM');
    await until(() => f.has('stopped'));
    expect(await child.exited).toBe(143);
  } finally {
    child.kill('SIGKILL');
    await reading;
  }
}, 15000);

test('SIGTERM keeps incomplete bytes after the handler and skips unstarted tasks', async () => {
  const f = fixture(
    {
      a: { ...task(`exec '${process.execPath}' signal.ts`), inputs: ['input', 'signal.ts'] },
      later: task('echo should-not-run'),
    },
    {},
    {
      'signal.ts': `import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => { console.log('handled'); process.exit(0); });
console.log(process.cwd());
console.log('ready');
writeFileSync('scratch/ready', 'yes');
setInterval(() => {}, 100);`,
    },
  );
  const { child, output } = spawn(f);
  try {
    await until(() => f.has('ready'));
    child.kill('SIGTERM');
    expect(await child.exited).toBe(143);
    const [out, err] = await output;
    expect(err).toBe('');
    const bytes = readFileSync(logPath(out, 'a', 'incomplete'), 'utf8');
    const sandbox = bytes.split('\n')[0] as string;
    expect(bytes).toBe(`${sandbox}\nready\nhandled\n`);
    expect(existsSync(sandbox)).toBe(false);
    expect(f.rows().map((r) => r.outcome)).toEqual(['incomplete']);
    expect(existsSync(join(f.env.PROOF_STATE_DIR, 'logs/jobs/tasks/later'))).toBe(false);
  } finally {
    await stop(child);
  }
}, 15000);

test('parallel captures separate a red from a green', () => {
  const f = fixture(
    Object.fromEntries(
      ['red', 'green'].map((id) => [
        id,
        task(
          `printf '${id}-out'; printf '${id}-err' >&2; touch scratch/${id}; ${wait(id === 'red' ? 'green' : 'red')}; ${id === 'red' ? 'false' : 'true'}`,
        ),
      ]),
    ),
  );
  const result = f.run('--jobs', '2');
  expect(result.code, result.err + result.out).toBe(1);
  expect(result.err).toBe('');
  expect(readFileSync(logPath(result.out, 'red'), 'utf8')).toBe('red-outred-err');
  for (const id of ['red', 'green'])
    expect(result.out).toContain(`--- ${id}\n${id}-out${id}-err\n`);
  expect(existsSync(join(f.env.PROOF_STATE_DIR, 'logs/jobs/tasks/green'))).toBe(false);
});

test('failed provider retains one log and no dependent captures; ready provider cleans up', () => {
  const f = fixture(
    { a: task('echo forbidden', ['stack']), b: task('echo forbidden', ['stack']) },
    {
      stack: {
        start: 'printf provider-out; printf provider-err >&2; test -f scratch/succeed',
        stop: 'echo stop >> scratch/stops',
      },
    },
  );
  const result = f.run('--jobs', '2');
  expect(result.code).toBe(1);
  const paths = [...result.out.matchAll(/provider 'stack' start failed; log: (.*)\n/g)];
  expect(paths).toHaveLength(1);
  const path = paths[0]?.[1] as string;
  expect(path).toContain('/logs/jobs/providers/stack/');
  expect(path).toEndWith('-no-key-red.log');
  expect(readFileSync(path, 'utf8')).toBe('provider-outprovider-err');
  expect(result.out).not.toContain('forbidden');
  expect(f.rows().map((r) => r.outcome)).toEqual(['incomplete', 'incomplete']);
  expect(f.read('stops')).toBe('stop\n');
  expect(readdirSync(join(f.env.PROOF_STATE_DIR, 'logs/jobs'))).toEqual(['providers']);
  f.mark('succeed');
  expect(f.run('--jobs', '2').code).toBe(0);
  expect(readdirSync(join(f.env.PROOF_STATE_DIR, 'logs/jobs/providers/stack'))).toHaveLength(1);
});

test('each task keeps its newest ten reds and a later green preserves them', () => {
  const f = fixture({
    a: task('cat scratch/control; test -f scratch/succeed'),
    other: task('echo other; false'),
  });
  const other = logPath(f.run('--tasks', 'other').out, 'other');
  const paths: string[] = [];
  for (let n = 1; n <= 11; n++) {
    f.repo.write('scratch/control', `run-${n}\n`);
    const result = f.run('--tasks', 'a');
    expect(result.code).toBe(1);
    paths.push(logPath(result.out, 'a'));
  }
  expect(new Set(paths).size).toBe(11);
  expect(existsSync(paths[0] as string)).toBe(false);
  for (let n = 1; n < paths.length; n++)
    expect(readFileSync(paths[n] as string, 'utf8')).toBe(`run-${n + 1}\n`);
  expect(readdirSync(join(f.env.PROOF_STATE_DIR, 'logs/jobs/tasks/a'))).toHaveLength(10);
  expect(existsSync(other)).toBe(true);
  expect(
    new Set(
      f
        .rows()
        .filter((r) => r.task === 'a')
        .map((r) => r.key),
    ).size,
  ).toBe(1);
  f.mark('succeed');
  expect(f.run('--tasks', 'a').code).toBe(0);
  expect(readdirSync(join(f.env.PROOF_STATE_DIR, 'logs/jobs/tasks/a'))).toHaveLength(10);
}, 15000);

test('provider retention cannot prune a task with the same printed label', () => {
  const f = fixture(
    { 'provider-stack': task('echo task-diagnostic; false'), dependent: task('true', ['stack']) },
    { stack: { start: 'echo provider-diagnostic; false' } },
  );
  const path = logPath(f.run('--tasks', 'provider-stack').out, 'provider-stack');
  for (let n = 0; n < 10; n++) {
    const result = f.run('--tasks', 'dependent');
    expect(result.code, result.err).toBe(1);
    expect(result.out).toContain("provider 'stack' start failed; log: ");
  }
  expect(readFileSync(path, 'utf8')).toBe('task-diagnostic\n');
}, 15000);

test('project and task ids remain distinct single safe path segments', () => {
  const ids = ['suite/a', 'suite:a', 'suite%2Fa', '..', '.'];
  for (const project of ['project/a', '..']) {
    const f = fixture(
      Object.fromEntries(ids.map((id) => [id, task(`printf '%s' '${id}'; false`)])),
    );
    const declaration = JSON.parse(readFileSync(join(f.repo.path, 'proof.yaml'), 'utf8'));
    f.repo.commit({ 'proof.yaml': JSON.stringify({ ...declaration, project }) });
    const result = f.run('--jobs', '2');
    expect(result.code).toBe(1);
    const paths = ids.map((id) => logPath(result.out, id));
    expect(new Set(paths).size).toBe(ids.length);
    const directory = join(
      f.env.PROOF_STATE_DIR,
      'logs',
      project === '..' ? '%2E%2E' : 'project%2Fa',
    );
    for (let i = 0; i < ids.length; i++) {
      const path = paths[i] as string;
      expect(path.startsWith(`${directory}/`)).toBe(true);
      expect(path.slice(directory.length + 1).split('/')).toHaveLength(3);
      expect(readFileSync(path, 'utf8')).toBe(ids[i] as string);
    }
  }
});

test('log finalization failure reports exit 2 while recording the actual red', () => {
  const f = fixture({ a: task('echo failure-marker; false') });
  mkdirSync(join(f.env.PROOF_STATE_DIR, 'logs/jobs/tasks'), { recursive: true });
  writeFileSync(join(f.env.PROOF_STATE_DIR, 'logs/jobs/tasks/a'), 'obstruction');
  const result = f.run();
  expect(result.code).toBe(2);
  expect(result.out).toMatch(/red a; log failed: .*EEXIST/);
  expect(result.out).not.toContain('; log:');
  expect(f.rows().map((r) => r.outcome)).toEqual(['red']);
});

test('retained private bytes and paths never enter either store', async () => {
  const pg = await new Postgres().start();
  try {
    const { PROOF_STORE, sql } = await pg.database();
    const f = fixture({ a: task('cat scratch/private; false') });
    const marker = crypto.randomUUID();
    f.repo.write('scratch/private', `${marker}\n`);
    const result = f.repo.cli(['run'], { ...f.env, PROOF_STORE });
    expect(result.code, result.err + result.out).toBe(1);
    const path = logPath(result.out, 'a');
    expect(readFileSync(path, 'utf8')).toBe(`${marker}\n`);
    expect(f.rows().map((r) => r.outcome)).toEqual(['red']);
    const shared = (await sql`SELECT outcome FROM results`) as { outcome: string }[];
    expect(Array.from(shared, (row) => row.outcome)).toEqual(['red']);
    const db = new Database(join(f.env.PROOF_STATE_DIR, 'proof.db'));
    try {
      const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[];
      for (const { name } of tables) {
        const rows = JSON.stringify(db.query(`SELECT * FROM "${name}"`).all());
        expect(rows).not.toContain(marker);
        expect(rows).not.toContain(path);
      }
    } finally {
      db.close();
    }
    const tables = await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
    for (const { tablename } of tables) {
      const rows = JSON.stringify(await sql.unsafe(`SELECT * FROM "${tablename}"`));
      expect(rows).not.toContain(marker);
      expect(rows).not.toContain(path);
    }
  } finally {
    await pg.close();
  }
}, 30000);

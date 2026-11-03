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
  expect(line, out).toBeDefined();
  const path = line?.split('; log: ')[1]?.split('; artifacts: ')[0];
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
  expect(path).toContain(
    `-${f
      .rows()
      .find((r) => r.task === 'red')
      ?.key.slice(0, 8)}-red.log`,
  );
  const bytes = readFileSync(path, 'utf8');
  const sandbox = bytes.split('\n')[2] as string;
  expect(bytes).toBe(`out\nerr\n${sandbox}\ntail`);
  expect(result.out.split(bytes)).toHaveLength(2);
  expect(existsSync(sandbox)).toBe(false);
  expect(existsSync(join(f.env.PROOF_STATE_DIR, 'logs/jobs/tasks/green'))).toBe(false);
  expect(readdirSync(join(f.env.PROOF_STATE_DIR, 'logs'))).toEqual(['jobs']);
  expect(
    f
      .rows()
      .map((r) => [r.task, r.outcome])
      .sort(),
  ).toEqual([
    ['green', 'green'],
    ['red', 'red'],
  ]);
  f.repo.git('worktree', 'remove', '--force', worktree);
  expect(readFileSync(path, 'utf8')).toBe(bytes);
});

test('serial stdout and stderr arrive live exactly once', async () => {
  const f = fixture({ a: task(`echo live-out; echo live-err >&2; ${wait('release')}`) });
  const child = f.repo.spawnCli(['run', '--jobs', '1'], f.env);
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
});

test('SIGTERM reaches a task while the live tail is behind a slow stdout', async () => {
  const f = fixture({
    a: task(
      `trap 'touch scratch/stopped; exit 0' TERM; touch scratch/started; i=0; while [ $i -lt 500000 ]; do echo ${'x'.repeat(99)}; i=$((i+1)); done`,
    ),
  });
  const child = f.repo.spawnCli(['run', '--jobs', '1'], f.env);
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
});

test('SIGTERM keeps incomplete bytes after the handler and skips unstarted tasks', async () => {
  const f = fixture(
    {
      a: {
        ...task(`exec '${process.execPath}' signal.ts`),
        ...{ artifacts: ['diagnostic'] },
        inputs: ['input', 'signal.ts'],
      },
      later: task('echo should-not-run'),
    },
    {},
    {
      'signal.ts': `import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => { writeFileSync('diagnostic', 'handled'); console.log('handled'); process.exit(0); });
console.log(process.cwd());
console.log('cat: omitted: No such file or directory');
console.log('ready');
writeFileSync('scratch/ready', 'yes');
setInterval(() => {}, 100);`,
      omitted: 'yes',
    },
  );
  const { child, output } = spawn(f, '--jobs', '1');
  try {
    await until(() => f.has('ready'));
    child.kill('SIGTERM');
    expect(await child.exited).toBe(143);
    const [out, err] = await output;
    expect(err).toBe('');
    const path = logPath(out, 'a', 'incomplete');
    expect(readFileSync(join(path.slice(0, -4), 'diagnostic'), 'utf8')).toBe('handled');
    expect(out).toContain(`; log: ${path}; artifacts: ${path.slice(0, -4)}`);
    const bytes = readFileSync(path, 'utf8');
    const sandbox = bytes.split('\n')[0] as string;
    expect(bytes).toBe(`${sandbox}\ncat: omitted: No such file or directory\nready\nhandled\n`);
    expect(existsSync(sandbox)).toBe(false);
    expect(out.split('\n').find((line) => line.startsWith('incomplete a;'))).not.toContain(
      'not delivered',
    );
    expect(out.match(/^progress:/gm)).toHaveLength(1);
    expect(out).toContain(
      'progress: 0/2 done; green 0, red 0, incomplete 1, proven 0, unreached 0; task a\n',
    );
    expect(out).toEndWith('summary: green 0, red 0, incomplete 1, proven 0, unreached 0\n');
    expect(f.rows().map((r) => r.outcome)).toEqual(['incomplete']);
    expect(existsSync(join(f.env.PROOF_STATE_DIR, 'logs/jobs/tasks/later'))).toBe(false);
  } finally {
    await stop(child);
  }
});

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
  expect(readdirSync(join(f.env.PROOF_STATE_DIR, 'logs'))).toEqual(['jobs']);
});

for (const jobs of [1, 2]) {
  test(`failed provider retains one log and no dependent captures; ready provider cleans up, jobs=${jobs}`, () => {
    const f = fixture(
      {
        a: task('echo forbidden', ['stack']),
        b: task('echo forbidden', ['stack']),
        independent: task('true'),
        unselected: task('echo forbidden', ['stack']),
      },
      {
        stack: {
          start:
            'printf "provider-out\\n"; printf "provider-err\\n" >&2; test -f scratch/succeed || exit 7',
          stop: 'echo stop >> scratch/stops',
        },
      },
    );
    const result = f.run('--jobs', String(jobs), '--tasks', 'a', 'b', 'independent');
    expect(result.code).toBe(1);
    const paths = [...result.out.matchAll(/provider 'stack' start failed: exit 7; log: (.*)\n/g)];
    expect(paths).toHaveLength(1);
    const path = paths[0]?.[1] as string;
    expect(isAbsolute(path)).toBe(true);
    expect(path).toContain('/logs/jobs/providers/stack/');
    expect(path).toEndWith('-no-key-red.log');
    expect(readFileSync(path, 'utf8')).toBe('provider-out\nprovider-err\n');
    const block = result.out.slice(result.out.indexOf("provider 'stack':"));
    expect(block).toBe(
      `provider 'stack': 2 tasks blocked\nprovider 'stack' start failed: exit 7; log: ${path}\n  provider-out\n  provider-err\nsummary: green 1, red 0, incomplete 2, proven 0, unreached 0\n`,
    );
    expect(result.out.match(/^progress:/gm)).toHaveLength(3);
    for (const id of ['a', 'b']) {
      expect(result.out).toMatch(
        new RegExp(`^progress: .*incomplete [12], proven 0, unreached 0; task ${id}$`, 'm'),
      );
      expect(result.out).toContain(`incomplete ${id}; blocked by provider 'stack'`);
      expect(result.out.indexOf(`incomplete ${id}`)).toBeLessThan(result.out.indexOf(block));
    }
    expect(result.out.indexOf('green independent')).toBeLessThan(result.out.indexOf(block));
    expect(result.out).not.toContain('forbidden');
    expect(
      f
        .rows()
        .map((r) => r.outcome)
        .sort(),
    ).toEqual(['green', 'incomplete', 'incomplete']);
    expect(f.read('stops')).toBe('stop\n');
    expect(readdirSync(join(f.env.PROOF_STATE_DIR, 'logs/jobs'))).toEqual(['providers']);
    f.mark('succeed');
    const ready = f.run('--jobs', String(jobs), '--tasks', 'a', 'b', 'independent');
    expect(ready.code).toBe(0);
    expect(ready.out).not.toContain("provider 'stack':");
    expect(ready.out).not.toContain('blocked by provider');
    expect(readdirSync(join(f.env.PROOF_STATE_DIR, 'logs/jobs/providers/stack'))).toHaveLength(1);
  });
}

test('failed startup remains a failure when its dependent becomes PROVEN', () => {
  const f = fixture(
    { a: task('true', ['stack']) },
    {
      stack: { start: 'git checkout -- input; echo failed-after-restore; exit 7' },
    },
  );
  expect(f.repo.cli(['record', 'a', '--outcome', 'green'], f.env).code).toBe(0);
  f.repo.write('input', 'changed');
  const result = f.run('--jobs', '2');
  expect(result.code).toBe(1);
  expect(result.out).toContain('PROVEN a:');
  expect(result.out).toContain("provider 'stack': 0 tasks blocked");
  expect(result.out).toContain("provider 'stack' start failed: exit 7; log: ");
  expect(result.out).not.toContain('incomplete a');
  expect(result.out).toEndWith('summary: green 0, red 0, incomplete 0, proven 1, unreached 0\n');
});

test('rejected export ends with its value-free cause and diagnostic tail', () => {
  const marker = crypto.randomUUID();
  const f = fixture(
    { a: task('echo forbidden', ['stack']) },
    {
      stack: { start: `echo PATH=${marker} > "$PROOF_PROVIDER_ENV"; echo harmless-diagnostic` },
    },
  );
  const result = f.run('--jobs', '2');
  expect(result.code).toBe(1);
  const block = result.out.slice(result.out.indexOf("provider 'stack':"));
  expect(block).toContain("provider 'stack': 1 tasks blocked");
  expect(block).toContain("start failed: environment line 1 'PATH': reserved name; log: ");
  expect(block).not.toContain('exit 0');
  expect(result.out.indexOf('incomplete a')).toBeLessThan(result.out.indexOf(block));
  expect(block).toEndWith(
    '  harmless-diagnostic\nsummary: green 0, red 0, incomplete 1, proven 0, unreached 0\n',
  );
  const path = block.match(/; log: (.*)\n/)?.[1] as string;
  expect(result.out + result.err + readFileSync(path, 'utf8')).not.toContain(marker);
  expect(f.rows().map((r) => r.outcome)).toEqual(['incomplete']);
});

for (const newline of ['', '\n']) {
  test(`provider final tail keeps exactly twenty lines, terminal newline=${!!newline}`, () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line-${i + 1}`);
    const bytes = lines.join('\n') + newline;
    const f = fixture(
      { a: task('true', ['stack']) },
      {
        stack: { start: `printf '%s' '${bytes}'; exit 3` },
      },
    );
    const result = f.run('--jobs', '2');
    expect(result.code).toBe(1);
    const block = result.out.slice(result.out.indexOf("provider 'stack':"));
    expect(block.split('\n').slice(2)).toEqual([
      ...lines.slice(-20).map((line) => `  ${line}`),
      'summary: green 0, red 0, incomplete 1, proven 0, unreached 0',
      '',
    ]);
    const path = block.match(/; log: (.*)\n/)?.[1] as string;
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });
}

test('unavailable provider tail preserves the final report and exit', () => {
  const f = fixture(
    { a: task('true', ['stack']), independent: task('true') },
    {
      stack: {
        start: 'echo diagnostic; exit 4',
        stop: 'rm "$PROOF_STATE_DIR"/logs/jobs/providers/stack/*.log',
      },
    },
  );
  const result = f.run('--jobs', '2');
  expect(result.code).toBe(1);
  expect(result.out).toContain("incomplete a; blocked by provider 'stack'");
  const block = result.out.slice(result.out.indexOf("provider 'stack':"));
  expect(result.out.indexOf('green independent')).toBeLessThan(result.out.indexOf(block));
  expect(block).toContain("provider 'stack': 1 tasks blocked");
  expect(block).toContain("provider 'stack' start failed: exit 4; log: /");
  expect(block).toContain('  log tail unavailable: ');
  expect(block).toContain('ENOENT');
});

test('each task keeps its newest ten reds and a later green preserves them', () => {
  const f = fixture({
    a: {
      ...task('cat scratch/control; cp scratch/control diagnostic; test -f scratch/succeed'),
      ...{ artifacts: ['diagnostic'] },
    },
    other: { ...task('echo other > diagnostic; false'), ...{ artifacts: ['diagnostic'] } },
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
  expect(existsSync((paths[0] as string).slice(0, -4))).toBe(false);
  for (let n = 1; n < paths.length; n++) {
    expect(readFileSync(paths[n] as string, 'utf8')).toBe(`run-${n + 1}\n`);
    expect(readFileSync(join((paths[n] as string).slice(0, -4), 'diagnostic'), 'utf8')).toBe(
      `run-${n + 1}\n`,
    );
  }
  expect(readdirSync(join(f.env.PROOF_STATE_DIR, 'logs/jobs/tasks/a'))).toHaveLength(20);
  expect(existsSync(other)).toBe(true);
  expect(readFileSync(join(other.slice(0, -4), 'diagnostic'), 'utf8')).toBe('other\n');
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
  expect(readdirSync(join(f.env.PROOF_STATE_DIR, 'logs/jobs/tasks/a'))).toHaveLength(20);
});

test('provider retention cannot prune a task with the same printed label', () => {
  const f = fixture(
    { 'provider-stack': task('echo task-diagnostic; false'), dependent: task('true', ['stack']) },
    { stack: { start: 'echo provider-diagnostic; false' } },
  );
  const path = logPath(f.run('--tasks', 'provider-stack').out, 'provider-stack');
  for (let n = 0; n < 10; n++) {
    const result = f.run('--tasks', 'dependent');
    expect(result.code, result.err).toBe(1);
    expect(result.out).toContain("provider 'stack' start failed: exit 1; log: ");
  }
  expect(readFileSync(path, 'utf8')).toBe('task-diagnostic\n');
});

test('captures finalized in the same millisecond retain distinct bytes', () => {
  const f = fixture({ a: task('cat scratch/control; false') });
  f.repo.write(
    'scratch/clock.ts',
    "Date.prototype.toISOString = () => '2026-10-31T12:00:00.123Z';",
  );
  const paths: string[] = [];
  for (const diagnostic of ['first', 'second']) {
    f.repo.write('scratch/control', `${diagnostic}\n`);
    const result = f.repo.cli(['run'], {
      ...f.env,
      BUN_OPTIONS: `--preload=${join(f.repo.path, 'scratch/clock.ts')}`,
    });
    expect(result.code, result.err).toBe(1);
    paths.push(logPath(result.out, 'a'));
  }
  expect(paths.every((path) => path.includes('/20261031T120000123Z-'))).toBe(true);
  expect(paths[0]).not.toBe(paths[1]);
  expect(paths.map((path) => readFileSync(path, 'utf8'))).toEqual(['first\n', 'second\n']);
});

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
});

test('task and provider log arguments round-trip through sh and zsh', () => {
  const f = fixture(
    { '(a)': task('printf task-bytes; false'), blocked: task('true', ['(stack)']) },
    { '(stack)': { start: 'printf provider-bytes; false' } },
  );
  const state = join(f.directory(), "space ' $ ` ; * ? [x]");
  const result = f.repo.cli(['run', '--jobs', '2'], { ...f.env, PROOF_STATE_DIR: state });
  expect(result.code).toBe(1);
  const arguments_ = [...result.out.matchAll(/; log: (.*)\n/g)].map((m) => m[1] as string);
  expect(arguments_).toHaveLength(2);
  for (const argument of arguments_) {
    const kind = argument.includes('/tasks/') ? 'tasks/(a)' : 'providers/(stack)';
    const directory = join(state, 'logs/jobs', kind);
    const path = join(directory, readdirSync(directory)[0] as string);
    expect(argument).toBe(`'${path.replaceAll("'", "'\"'\"'")}'`);
    for (const shell of ['sh', 'zsh']) {
      const read = Bun.spawnSync([shell, '-c', `cat ${argument}`]);
      expect(read.exitCode, read.stderr.toString()).toBe(0);
      expect(read.stdout.toString()).toBe(
        kind.startsWith('tasks') ? 'task-bytes' : 'provider-bytes',
      );
    }
  }
});

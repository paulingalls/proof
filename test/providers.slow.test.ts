import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider, Task } from '../src/declarations';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'proof-providers-'));
  dirs.push(path);
  return path;
}
function fixture() {
  const repo = new Repo();
  repos.push(repo);
  const control = directory();
  const env = { PROOF_STATE_DIR: directory(), TMPDIR: directory(), CONTROL: control };
  const mark = (name: string) => `echo ${name} >> '${control}/log'`;
  const task = (run = 'true', inputs = ['input'], needs = ['stack']): Task => ({
    run,
    inputs,
    needs,
  });
  const commit = (
    tasks: Record<string, Task>,
    providers: Record<string, Provider> = {
      stack: { start: mark('start'), stop: mark('stop') },
    },
    files = {},
  ) =>
    repo.commit({
      input: 'original',
      'proof.yaml': JSON.stringify({ version: 1, project: 'providers', providers, tasks }),
      ...files,
    });
  const cli = (...args: string[]) => repo.cli(args, env);
  const seed = (id: string, outcome = 'green') => {
    expect(cli('record', id, '--outcome', outcome).code).toBe(0);
  };
  const log = () =>
    existsSync(join(control, 'log'))
      ? readFileSync(join(control, 'log'), 'utf8').trim().split('\n')
      : [];
  const rows = (table = 'results') => {
    const db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
    try {
      return db.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as {
        task: string;
        outcome: string;
        dirty: number;
        seconds: number | null;
        key: string;
      }[];
    } finally {
      db.close();
    }
  };
  return { repo, env, control, mark, task, commit, cli, seed, log, rows };
}

test('validates root providers and included needs; lifecycle declarations never enter key meaning', () => {
  const f = fixture();
  const tasks = {
    a: f.task(),
    yaml: f.task('true', ['proof.yaml']),
    script: f.task('true', ['start.sh']),
  };
  const providers = { stack: { start: 'true' }, other: { start: 'true' } };
  const before = f.commit(tasks, providers, { 'start.sh': 'true' });
  expect(f.cli('plan').code).toBe(0);
  for (const id of Object.keys(tasks)) f.seed(id);
  tasks.a.needs = ['other'];
  providers.stack.start = 'echo changed';
  const after = f.commit(tasks, providers);
  expect(f.repo.check([{ name: 'meaning', from: before, to: after, expect: ['yaml'] }]).code).toBe(
    0,
  );
  expect(JSON.parse(f.cli('plan', '--json').out).map((r: { state: string }) => r.state)).toEqual([
    'PROVEN',
    'RUN',
    'PROVEN',
  ]);
  const script = f.repo.commit({ 'start.sh': 'echo changed' });
  expect(
    f.repo.check([{ name: 'selected script', from: after, to: script, expect: ['script'] }]).code,
  ).toBe(0);
  f.repo.commit({
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'providers',
      providers,
      include: 'proof.d/*.yaml',
      tasks: {},
    }),
    'proof.d/tasks.yaml': JSON.stringify({ tasks: { included: f.task() } }),
  });
  const included = f.cli('plan', '--json');
  expect(included.code).toBe(0);
  expect(JSON.parse(included.out)).toEqual([
    { task: 'included', state: 'RUN', reason: 'no proof for key', providers: ['stack'] },
  ]);
  for (const [providers, needs, message] of [
    [[], ['stack'], 'providers'],
    [{ stack: {} }, ['stack'], 'start'],
    [{ stack: { start: '' } }, ['stack'], 'start'],
    [{ stack: { start: 'true', stop: 1 } }, ['stack'], 'stop'],
    [{ stack: { start: 'true', extra: true } }, ['stack'], 'extra'],
    [{ stack: { start: 'true' } }, 'stack', 'needs'],
    [{ stack: { start: 'true' } }, ['unknown'], 'unknown'],
  ]) {
    f.repo.commit({
      'proof.yaml': JSON.stringify({
        version: 1,
        project: 'providers',
        providers,
        tasks: { a: { run: 'true', inputs: ['input'], needs } },
      }),
    });
    const result = f.cli('plan');
    expect(result.code).toBe(2);
    expect(result.err).toContain(String(message));
  }
});

test('plans exactly RUN providers without starting them, before any run commands', () => {
  const f = fixture();
  f.commit(
    {
      proven: f.task('true', ['input'], ['only-proven']),
      a: f.task('echo TASK-MARK', ['input'], ['stack', 'second', 'stack']),
      b: f.task('true', ['input'], ['second']),
    },
    {
      stack: { start: `echo START-MARK; ${f.mark('start')}` },
      second: { start: f.mark('second') },
      unused: { start: f.mark('unused') },
      'only-proven': { start: f.mark('only-proven') },
    },
  );
  f.seed('proven');
  const plan = f.cli('plan');
  expect(plan.code).toBe(0);
  expect(plan.out).toContain('a: no proof for key; providers: stack, second');
  const rows = JSON.parse(f.cli('plan', '--json').out);
  expect(rows.map((r: { providers?: string[] }) => r.providers)).toEqual([
    undefined,
    ['stack', 'second'],
    ['second'],
  ]);
  expect(f.log()).toEqual([]);
  const result = f.cli('run');
  expect(result.code).toBe(0);
  expect(result.out.indexOf('RUN b:')).toBeLessThan(result.out.indexOf('START-MARK'));
  expect(result.out.indexOf('START-MARK')).toBeLessThan(result.out.indexOf('TASK-MARK'));
  expect(f.log()).toEqual(['start', 'second']);
});

test('one start and stop surround only RUN dependents, even after a red', () => {
  const f = fixture();
  f.commit({
    proven: f.task(f.mark('proven')),
    first: f.task(f.mark('first')),
    second: f.task(`${f.mark('second')}; exit 1`),
    unrelated: f.task(f.mark('unrelated'), ['input'], []),
  });
  f.seed('proven');
  const result = f.cli('run');
  expect(result.code).toBe(1);
  expect(f.log()).toEqual(['start', 'first', 'second', 'stop', 'unrelated']);
  expect(f.rows().map((r) => r.outcome)).toEqual(['green', 'green', 'red', 'green']);
});

test('all proven needs start nothing; a changed dependent starts exactly once', () => {
  const f = fixture();
  f.commit({ a: f.task(f.mark('a')), b: f.task(f.mark('b')) });
  f.seed('a');
  f.seed('b');
  expect(f.cli('run').code).toBe(0);
  expect(f.log()).toEqual([]);
  expect(f.rows()).toHaveLength(2);
  f.repo.commit({ input: 'changed' });
  expect(f.cli('run', '--tasks', 'a').code).toBe(0);
  expect(f.log()).toEqual(['start', 'a', 'stop']);
});

test('providers use checkout and caller env while dependents retain sandbox isolation', () => {
  const f = fixture();
  const provider = `test -d .git && test -f private && test "$OTHER" = caller && ${f.mark('provider')}`;
  f.commit(
    {
      a: {
        ...f.task(
          `test ! -e .git && test ! -e private && test "$MODE" = declared && test -z "$OTHER" && ${f.mark('task')}`,
        ),
        env: ['MODE'],
      },
    },
    { stack: { start: provider, stop: provider } },
    { private: 'checkout only' },
  );
  const result = f.repo.cli(['run'], { ...f.env, OTHER: 'caller', MODE: 'declared' });
  expect(result.code).toBe(0);
  expect(f.log()).toEqual(['provider', 'task', 'provider']);
  expect(f.rows('proofs')).toHaveLength(1);
});

test('failed start blocks keyed, dirty and undecidable dependents without touching proofs', () => {
  const f = fixture();
  f.commit(
    {
      a: f.task(f.mark('a')),
      contested: f.task(f.mark('contested')),
      proven: f.task(f.mark('proven')),
      dirty: f.task(f.mark('dirty'), ['dirty']),
      noKey: f.task(f.mark('noKey'), ['missing']),
      independent: f.task(f.mark('independent'), ['input'], []),
    },
    { stack: { start: `${f.mark('start')}; exit 1`, stop: f.mark('stop') } },
    { dirty: 'original' },
  );
  f.seed('contested');
  f.seed('contested', 'red');
  f.seed('proven');
  const proofs = f.rows('proofs');
  const contests = f.rows('contradictions');
  f.repo.write('dirty', 'working');
  const result = f.cli('run');
  expect(result.code).toBe(1);
  expect(result.out).toContain("provider 'stack' start failed");
  expect(result.out).toContain('incomplete noKey; not recorded:');
  expect(f.log()).toEqual(['start', 'stop', 'independent']);
  expect(
    f
      .rows()
      .slice(3)
      .map((r) => [r.task, r.outcome, r.seconds, r.dirty]),
  ).toEqual([
    ['a', 'incomplete', null, 1],
    ['contested', 'incomplete', null, 1],
    ['dirty', 'incomplete', null, 1],
    ['independent', 'green', expect.any(Number), 1],
  ]);
  expect(f.rows('proofs')).toEqual(proofs);
  expect(f.rows('contradictions')).toEqual(contests);
  const beforeDirtyDeclaration = f.rows();
  f.repo.write('proof.yaml', `${readFileSync(join(f.repo.path, 'proof.yaml'), 'utf8')}\n`);
  const dirtyDeclaration = f.cli('run');
  expect(dirtyDeclaration.code).toBe(1);
  expect(dirtyDeclaration.out).toContain('incomplete a; not recorded: dirty declaration');
  expect(f.rows()).toEqual(beforeDirtyDeclaration);
});

test('stop failure names provider, attempts other stops and preserves task proof', () => {
  const f = fixture();
  f.commit(
    { a: f.task('true', ['input'], ['stack', 'other']) },
    {
      stack: { start: 'true', stop: `${f.mark('stop')}; exit 1` },
      other: { start: 'true', stop: f.mark('other-stop') },
    },
  );
  const result = f.cli('run');
  expect(result.code).toBe(1);
  expect(result.out).toContain("provider 'stack' stop failed");
  expect(f.log()).toEqual(['stop', 'other-stop']);
  expect(f.rows('proofs')).toHaveLength(1);
});

test('throw during materialization still stops an attempted provider', () => {
  const f = fixture();
  f.commit({ a: f.task('true', ['link']) });
  symlinkSync('input', join(f.repo.path, 'link'));
  f.repo.commit({});
  expect(f.cli('run').code).toBe(2);
  expect(f.log()).toEqual(['start', 'stop']);
  expect(f.rows()).toEqual([]);
});

for (const committed of [false, true]) {
  test(`provider edit committed=${committed} refreshes sandbox without publishing stale proof`, () => {
    const f = fixture();
    f.commit(
      {
        a: f.task('test "$(cat input)" = changed'),
        later: f.task('test "$(cat input)" = original'),
      },
      {
        stack: {
          start: `echo changed > input${committed ? '; git add input; git commit -qm changed' : ''}`,
          stop: f.mark('stop'),
        },
      },
    );
    f.seed('later');
    const proofs = f.rows('proofs');
    const result = f.cli('run', ...(committed ? ['--tasks', 'a'] : []));
    expect(result.out).toContain('green a; no proof published:');
    expect(result.code).toBe(committed ? 0 : 1);
    expect(f.rows('proofs')).toEqual(proofs);
    expect(f.rows('contradictions')).toEqual([]);
    expect(f.cli('plan').out).toContain('RUN a:');
    if (!committed) {
      expect(result.out).toContain('PROVEN later:');
      expect(result.out).toContain('RUN later: undecidable: dirty input');
      expect(result.out).toContain('red later');
    }
  });
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 6000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('fixture timed out');
    await Bun.sleep(10);
  }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  for (const during of ['start', 'task']) {
    test(`${signal} during ${during} drains group, records pending dependents and stops once`, async () => {
      const f = fixture();
      const command = `echo $$ > "$CONTROL/leader"; '${process.execPath}' wait.ts; :`;
      f.commit(
        {
          a: {
            ...f.task(during === 'task' ? command : f.mark('a'), ['wait.ts'], ['stack', 'second']),
            env: ['CONTROL'],
          },
          later: f.task(f.mark('later')),
          proven: f.task(f.mark('proven')),
          independent: f.task(f.mark('independent'), ['input'], []),
        },
        {
          stack: {
            start: during === 'start' ? command : f.mark('start'),
            stop: `test -f "$CONTROL/exited" && ${f.mark('stop')}`,
          },
          second: { start: f.mark('second') },
        },
        {
          'wait.ts': `import { writeFileSync } from 'node:fs';
process.on('${signal}', async () => {
  writeFileSync(process.env.CONTROL + '/received', '${signal}');
  await Bun.sleep(100);
  writeFileSync(process.env.CONTROL + '/exited', 'yes');
  process.exit(0);
});
setInterval(() => {}, 1000);
writeFileSync(process.env.CONTROL + '/ready', String(process.pid));`,
        },
      );
      f.seed('proven');
      f.seed('a');
      f.seed('a', 'red');
      const proofs = f.rows('proofs');
      const contests = f.rows('contradictions');
      const cli = f.repo.spawnCli(['run'], f.env);
      const output = Promise.all([
        new Response(cli.stdout).text(),
        new Response(cli.stderr).text(),
      ]);
      try {
        await until(() => existsSync(join(f.control, 'ready')));
        process.kill(cli.pid, signal);
        await until(() => cli.exitCode !== null);
        expect(await cli.exited).toBe(signal === 'SIGINT' ? 130 : 143);
        const [out, err] = await output;
        expect(err).toBe('');
        expect(out).toContain('incomplete a');
        expect(readFileSync(join(f.control, 'received'), 'utf8')).toBe(signal);
        expect(f.log()).toEqual(during === 'start' ? ['stop'] : ['start', 'second', 'stop']);
        expect(
          f
            .rows()
            .slice(3)
            .map((r) => [r.task, r.outcome]),
        ).toEqual([
          ['a', 'incomplete'],
          ['later', 'incomplete'],
        ]);
        expect(f.rows('proofs')).toEqual(proofs);
        expect(f.rows('contradictions')).toEqual(contests);
        expect(readdirSync(f.env.TMPDIR)).toEqual([]);
      } finally {
        for (const file of ['leader', 'ready']) {
          const path = join(f.control, file);
          if (existsSync(path)) {
            const pid = Number(readFileSync(path, 'utf8'));
            try {
              process.kill(file === 'leader' ? -pid : pid, 'SIGKILL');
            } catch {}
          }
        }
        if (cli.exitCode === null) cli.kill('SIGKILL');
        await cli.exited;
        await output;
      }
    }, 15000);
  }
}

test('first interrupt during stop lets teardown finish and cleanup does not drain detached jobs', async () => {
  const f = fixture();
  f.commit(
    { a: f.task() },
    { stack: { start: 'true', stop: `'${process.execPath}' stop.ts` } },
    {
      'stop.ts': `import { writeFileSync } from 'node:fs';
process.on('SIGINT', () => writeFileSync(process.env.CONTROL + '/wrong-signal', 'yes'));
writeFileSync(process.env.CONTROL + '/stopping', 'yes');
await Bun.sleep(200);
const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
writeFileSync(process.env.CONTROL + '/background', String(child.pid));
child.unref();
writeFileSync(process.env.CONTROL + '/stopped', 'yes');`,
    },
  );
  const cli = f.repo.spawnCli(['run'], f.env);
  const output = Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text()]);
  try {
    await until(() => existsSync(join(f.control, 'stopping')));
    process.kill(cli.pid, 'SIGINT');
    await until(() => cli.exitCode !== null);
    expect(await cli.exited).toBe(130);
    expect(existsSync(join(f.control, 'wrong-signal'))).toBe(false);
    expect(existsSync(join(f.control, 'stopped'))).toBe(true);
  } finally {
    const background = join(f.control, 'background');
    if (existsSync(background)) {
      try {
        process.kill(Number(readFileSync(background, 'utf8')), 'SIGKILL');
      } catch {}
    }
    if (cli.exitCode === null) cli.kill('SIGKILL');
    await cli.exited;
    await output;
  }
}, 15000);

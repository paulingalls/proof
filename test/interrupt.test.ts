import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return false;
  }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for fixture condition');
    await Bun.sleep(10);
  }
}

for (const [signal, child] of [
  ['SIGTERM', false],
  ['SIGINT', false],
  ['SIGTERM', true],
] as const) {
  test(`${signal}, child=${child}: records incomplete and cleans up before exit`, async () => {
    const repo = new Repo();
    const control = mkdtempSync(join(tmpdir(), 'proof-interrupt-'));
    const state = mkdtempSync(join(tmpdir(), 'proof-state-'));
    const temporary = mkdtempSync(join(tmpdir(), 'proof-tmp-'));
    const env = { PROOF_STATE_DIR: state, TMPDIR: temporary, CONTROL: control };
    const ready = join(control, 'ready');
    const commit = repo.commit({
      'proof.yaml': JSON.stringify({
        version: 1,
        project: 'interrupt',
        tasks: {
          first: {
            run: `echo $$ > "$CONTROL/leader"; ${child ? '' : 'exec '}'${process.execPath}' task.ts "$$"${child ? '; :' : ''}`,
            inputs: ['task.ts'],
            env: ['CONTROL'],
          },
          later: { run: 'touch "$CONTROL/later"', inputs: ['task.ts'], env: ['CONTROL'] },
        },
      }),
      'task.ts': `import { writeFileSync, renameSync } from 'node:fs';
const control = process.env.CONTROL;
process.on('${signal}', async () => {
  writeFileSync(control + '/received', '${signal}');
  if (${child}) {
    while (true) {
      try { process.kill(Number(process.argv[2]), 0); } catch { break; }
      await Bun.sleep(10);
    }
    await Bun.sleep(300);
    writeFileSync(control + '/exited', 'yes');
  }
  process.exit(0);
});
setInterval(() => {}, 1000);
writeFileSync(control + '/pending', JSON.stringify({ pid: process.pid, cwd: process.cwd() }));
renameSync(control + '/pending', control + '/ready');`,
    });
    let cli: ReturnType<Repo['spawnCli']> | undefined;
    let output: Promise<string[]> | undefined;
    let db: Database | undefined;
    let task: { pid: number; cwd: string } | undefined;
    try {
      if (signal === 'SIGINT') {
        for (const outcome of ['green', 'red'])
          expect(repo.cli(['record', 'first', '--outcome', outcome], env).code).toBe(0);
        expect(repo.cli(['plan'], env).out).toContain('RUN first: contested:');
      }
      const planned = repo.cli(['plan'], env);
      expect(planned.err).toBe('');
      expect(planned.code).toBe(0);
      db = new Database(join(state, 'proof.db'));
      const rows = (table: string) => db?.query(`SELECT * FROM ${table} ORDER BY rowid`).all();
      const proofs = rows('proofs');
      const contests = rows('contradictions');
      const before = rows('results') as { key: string }[];
      cli = repo.spawnCli(['run'], env);
      output = Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text()]);
      await until(() => existsSync(ready));
      const running: { pid: number; cwd: string } = JSON.parse(readFileSync(ready, 'utf8'));
      task = running;
      expect(alive(running.pid)).toBe(true);
      expect(existsSync(running.cwd)).toBe(true);
      process.kill(cli.pid, signal);
      await until(() => cli?.exitCode !== null);
      expect(await cli.exited).toBe(signal === 'SIGINT' ? 130 : 143);
      if (child) {
        expect(existsSync(join(control, 'exited'))).toBe(true);
        expect(alive(running.pid)).toBe(false);
      }
      const [out, err] = await output;
      expect(err).toBe('');
      expect(out).toContain('incomplete first');
      expect(readFileSync(join(control, 'received'), 'utf8')).toBe(signal);
      const results = rows('results') as {
        outcome: string;
        key: string;
        commit: string;
        seconds: number;
        task: string;
      }[];
      expect(results).toHaveLength(before.length + 1);
      const last = results[results.length - 1];
      if (!last) throw new Error('missing interrupted result');
      expect(last.outcome).toBe('incomplete');
      expect(last.task).toBe('first');
      expect(last.commit).toBe(commit);
      expect(last.key).toMatch(/^[a-f0-9]{64}$/);
      if (before[0]) expect(last.key).toBe(before[0].key);
      expect(Number.isFinite(last.seconds) && last.seconds >= 0).toBe(true);
      expect(rows('proofs')).toEqual(proofs);
      expect(rows('contradictions')).toEqual(contests);
      expect(repo.cli(['plan'], env).out).toContain(
        signal === 'SIGINT' ? 'RUN first: contested:' : 'RUN first: no proof for key',
      );
      expect(existsSync(join(control, 'later'))).toBe(false);
      expect(alive(running.pid)).toBe(false);
      expect(existsSync(running.cwd)).toBe(false);
      expect(readdirSync(temporary)).toEqual([]);
    } finally {
      const leader = join(control, 'leader');
      for (const pid of [
        task?.pid,
        existsSync(leader) ? Number(readFileSync(leader, 'utf8')) : undefined,
        cli?.pid,
      ]) {
        if (pid && alive(pid)) {
          const group = Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(pid)]);
          process.kill(Number(group.stdout.toString().trim()) === pid ? -pid : pid, 'SIGKILL');
          await until(() => !alive(pid));
        }
      }
      if (cli) await cli.exited;
      if (output) await output;
      db?.close();
      repo.close();
      for (const path of [control, state, temporary])
        rmSync(path, { recursive: true, force: true });
    }
  }, 15000);
}

test('a second SIGINT kills a task whose background child ignores the first', async () => {
  const repo = new Repo();
  const control = mkdtempSync(join(tmpdir(), 'proof-interrupt-'));
  const state = mkdtempSync(join(tmpdir(), 'proof-state-'));
  const temporary = mkdtempSync(join(tmpdir(), 'proof-tmp-'));
  const env = { PROOF_STATE_DIR: state, TMPDIR: temporary, CONTROL: control };
  repo.commit({
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'interrupt',
      tasks: {
        first: {
          run: 'sleep 30 & echo $! > "$CONTROL/bg"; touch "$CONTROL/ready"; wait',
          inputs: ['proof.yaml'],
          env: ['CONTROL'],
        },
      },
    }),
  });
  const cli = repo.spawnCli(['run'], env);
  const output = new Response(cli.stdout).text();
  let background: number | undefined;
  try {
    await until(() => existsSync(join(control, 'ready')));
    background = Number(readFileSync(join(control, 'bg'), 'utf8'));
    process.kill(cli.pid, 'SIGINT');
    await Bun.sleep(200);
    expect(cli.exitCode).toBe(null);
    process.kill(cli.pid, 'SIGINT');
    await until(() => cli.exitCode !== null);
    expect(await cli.exited).toBe(130);
    expect(await output).toContain('incomplete first');
    await until(() => !alive(background as number));
    expect(readdirSync(temporary)).toEqual([]);
  } finally {
    if (background && alive(background)) process.kill(background, 'SIGKILL');
    if (cli.exitCode === null) cli.kill('SIGKILL');
    await cli.exited;
    repo.close();
    for (const path of [control, state, temporary]) rmSync(path, { recursive: true, force: true });
  }
}, 15000);

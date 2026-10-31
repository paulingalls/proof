import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fixture, stop, task, until, wait } from './support/jobs';

function logPath(out: string, id: string, outcome = 'red') {
  const line = out.split('\n').find((line) => line.startsWith(`${outcome} ${id}; log: `));
  expect(line).toBeDefined();
  const path = line!.split('; log: ')[1]!;
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
  expect(path.startsWith(`${f.env.PROOF_STATE_DIR}/logs/jobs/red/`)).toBe(true);
  expect(path).toContain(`-${f.rows()[0]!.key.slice(0, 8)}-red.log`);
  const bytes = readFileSync(path, 'utf8');
  const sandbox = bytes.split('\n')[2]!;
  expect(bytes).toBe(`out\nerr\n${sandbox}\ntail`);
  expect(result.out.split(bytes)).toHaveLength(2);
  expect(existsSync(sandbox)).toBe(false);
  expect(existsSync(join(f.env.PROOF_STATE_DIR, 'logs/jobs/green'))).toBe(false);
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

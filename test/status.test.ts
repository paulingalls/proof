import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../src/declarations';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const states: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const path of states.splice(0)) rmSync(path, { recursive: true, force: true });
});
const task = (inputs: Task['inputs'] = ['src/**']): Task => ({
  run: 'touch executed; exit 99',
  inputs,
});
function fixture(tasks: Record<string, Task> = { gate: task() }, extra = {}) {
  const repo = new Repo();
  repos.push(repo);
  repo.commit({
    'proof.yaml': JSON.stringify({ version: 1, project: 'status', tasks, ...extra }),
    'src/a.ts': 'export default 1;',
  });
  const path = mkdtempSync(join(tmpdir(), 'proof-status-'));
  states.push(path);
  return { repo, env: { PROOF_STATE_DIR: path } };
}
function record(repo: Repo, env: Record<string, string>, id = 'gate', outcome = 'green') {
  const result = repo.cli(['record', id, '--outcome', outcome], env);
  expect(result.code).toBe(0);
  if (outcome === 'green') expect(result.out).toContain('proof published');
}
function status(repo: Repo, env: Record<string, string>, ref = 'HEAD') {
  return repo.cli(['status', '--ref', ref, '--json'], env);
}

test('historical declarations and proofs, aggregate exit, tags and unknown refs', () => {
  const { repo, env } = fixture(undefined, { include: 'proof.d/*.yaml' });
  const a = repo.commit({
    'proof.d/extra.yaml': JSON.stringify({ tasks: { extra: task(['other']) } }),
    other: 'one',
  });
  record(repo, env);
  repo.git('tag', 'release', a);
  repo.git('tag', '-a', 'annotated', '-m', 'release', a);
  const b = repo.commit({
    'src/a.ts': 'export default 2;',
    'proof.d/extra.yaml': JSON.stringify({ tasks: { renamed: task(['other']) } }),
  });
  const first = status(repo, env, a);
  expect(first.code).toBe(1);
  expect(JSON.parse(first.out)).toEqual([
    {
      task: 'gate',
      state: 'PROVEN',
      reason: expect.stringMatching(new RegExp(`^proven at ${a} on ${hostname()} .+Z$`)),
    },
    { task: 'extra', state: 'RUN', reason: 'no proof for key' },
  ]);
  const clone = new Repo(repo);
  repos.push(clone);
  clone.git('checkout', '--detach', a);
  record(clone, env, 'extra');
  const proven = status(repo, env, a);
  expect(proven.code).toBe(0);
  expect(JSON.parse(proven.out).map((row: { state: string }) => row.state)).toEqual([
    'PROVEN',
    'PROVEN',
  ]);
  for (const tag of ['release', 'annotated']) expect(status(repo, env, tag)).toEqual(proven);
  const later = status(repo, env, b);
  expect(later.code).toBe(1);
  expect(JSON.parse(later.out)[0]).toEqual({
    task: 'gate',
    state: 'RUN',
    reason: 'no proof for key',
  });
  expect(repo.git('rev-parse', 'HEAD')).toBe(b);
  const missing = status(repo, env, 'missing-release');
  expect(missing.code).toBe(2);
  expect(missing.err).toContain("ref 'missing-release'");
  expect(missing.out).toBe('');
}, 30_000);

test('clean HEAD matches plan rows and rendering for proof, needs, contest and undecidable', () => {
  const { repo, env } = fixture(
    {
      gate: { ...task(), links: ['node_modules'] },
      pending: { ...task(), needs: ['service'] },
      contested: task(),
      unknown: task(['missing/**']),
    },
    { providers: { service: { start: 'touch executed; exit 99' } } },
  );
  record(repo, env);
  record(repo, env, 'contested');
  record(repo, env, 'contested', 'red');
  const planned = repo.cli(['plan', '--json'], env);
  const result = status(repo, env);
  expect(planned.code).toBe(0);
  expect(result.code).toBe(1);
  expect(result.out).toBe(planned.out);
  const rows = JSON.parse(result.out);
  expect(rows[0].state).toBe('PROVEN');
  expect(rows[0].reason).toContain('; trusted links: node_modules');
  expect(rows[1].providers).toEqual(['service']);
  expect(rows[2].reason).toContain('contested:');
  expect(rows[3].reason).toContain('undecidable:');
  expect(repo.cli(['status', '--ref', 'HEAD'], env).out).toBe(repo.cli(['plan'], env).out);
  expect(existsSync(join(repo.path, 'executed'))).toBe(false);
}, 30_000);

test('status ignores checkout link escapes and missing installations across checkouts', () => {
  const { repo, env } = fixture({ gate: { ...task(), links: ['node_modules'] } });
  record(repo, env);
  const original = status(repo, env);
  expect(original.code).toBe(0);
  rmSync(join(repo.path, 'node_modules/example'), { recursive: true });
  symlinkSync(join(repo.path, 'src'), join(repo.path, 'node_modules/example'));
  const planned = repo.cli(['plan'], env);
  expect(planned.out).toContain('RUN gate: untrusted links');
  expect(status(repo, env)).toEqual(original);
  rmSync(join(repo.path, 'node_modules'), { recursive: true });
  expect(status(repo, env)).toEqual(original);
  const clone = new Repo(repo);
  repos.push(clone);
  expect(status(clone, env)).toEqual(original);
}, 30_000);

test('status uses committed blobs, import closure, projections and declarations despite dirt', () => {
  const { repo, env } = fixture(
    { gate: task([{ 'imports-of': 'src/a.ts' }, 'src/**']) },
    { include: 'proof.d/*.yaml' },
  );
  repo.commit({
    'src/a.ts': "import './b';",
    'src/b.ts': 'export default 1;',
    'proof.d/extra.yaml': JSON.stringify({
      tasks: {
        projected: task([{ path: 'config.json', json: ['selected'] }]),
      },
    }),
    'config.json': '{"selected":1}',
  });
  record(repo, env);
  record(repo, env, 'projected');
  const original = status(repo, env);
  expect(original.code).toBe(0);
  for (const [path, staged] of [
    ['src/b.ts', false],
    ['src/b.ts', true],
    ['src/new.ts', false],
  ] as const) {
    repo.write(path, 'export default 2;');
    if (staged) repo.git('add', path);
    expect(status(repo, env)).toEqual(original);
    expect(repo.cli(['plan'], env).out).toContain('RUN gate: undecidable: dirty input');
    repo.git('reset', '--hard', 'HEAD');
    if (path === 'src/new.ts') rmSync(join(repo.path, path));
  }
  repo.write('proof.yaml', 'invalid: [');
  repo.write('proof.d/extra.yaml', 'invalid: [');
  repo.write('config.json', '{"selected":2}');
  expect(status(repo, env)).toEqual(original);
}, 30_000);

test('invalid committed declarations stay invalid despite a working repair', () => {
  const { repo, env } = fixture();
  const valid = repo.git('show', 'HEAD:proof.yaml');
  const invalid = repo.commit({ 'proof.yaml': '{"version":99,"project":"status"}' });
  repo.write('proof.yaml', valid);
  const result = status(repo, env, invalid);
  expect(result.code).toBe(2);
  expect(result.err).toContain('version must be 1');
  expect(result.out).toBe('');
});

test('caller declared env selects the proof and unreachable store uses the replica once', () => {
  const { repo, env } = fixture({ gate: { ...task(), env: ['PROOF_STATUS_MODE'] } });
  const same = { ...env, PROOF_STATUS_MODE: 'a' };
  record(repo, same);
  expect(status(repo, same).code).toBe(0);
  const changed = status(repo, { ...same, PROOF_STATUS_MODE: 'b' });
  expect(changed.code).toBe(1);
  expect(JSON.parse(changed.out)[0].reason).toBe('no proof for key');
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  const offline = status(repo, {
    ...same,
    PROOF_STORE: `postgres://proof@127.0.0.1:${port}/proof`,
  });
  expect(offline.code).toBe(0);
  expect(offline.out).toBe(status(repo, same).out);
  expect(offline.err.trim().split('\n')).toEqual([
    expect.stringMatching(/^store unreachable \(.+\); using this machine's own proofs$/),
  ]);
}, 30_000);

test('status requires exactly one ref and optional JSON in either order', () => {
  const { repo, env } = fixture();
  for (const args of [
    [],
    ['--ref'],
    ['--ref', '--json'],
    ['HEAD'],
    ['--ref', 'HEAD', 'extra'],
    ['--ref', 'HEAD', '--unknown'],
    ['--ref', 'HEAD', '--ref', 'HEAD'],
    ['--json', '--json', '--ref', 'HEAD'],
  ]) {
    expect(repo.cli(['status', ...args], env)).toEqual({
      code: 2,
      out: '',
      err: 'proof: usage: proof status --ref <ref> [--set <name>] [--json]\n',
    });
  }
  expect(repo.cli(['status', '--json', '--ref', 'HEAD'], env)).toEqual(status(repo, env));
});

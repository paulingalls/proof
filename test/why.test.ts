import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const states: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const path of states.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const repo = new Repo();
  repos.push(repo);
  repo.commit({
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'why',
      tasks: {
        gate: {
          run: 'touch executed; exit 99',
          inputs: ['src/**', '!src/excluded', { path: 'config.json', json: ['selected'] }],
          env: ['PROOF_WHY_MODE'],
        },
      },
    }),
    'src/a': 'one',
    'src/b': 'two',
    'src/excluded': 'excluded',
    'config.json': '{"selected":1}',
  });
  const path = mkdtempSync(join(tmpdir(), 'proof-why-'));
  states.push(path);
  return { repo, env: { PROOF_STATE_DIR: path } };
}

test('why prints plan decision and current parts without executing, validates task arguments', () => {
  const { repo, env } = fixture();
  const doc = JSON.parse(repo.git('show', 'HEAD:proof.yaml'));
  doc.providers = { service: { start: 'touch executed; exit 99' } };
  doc.tasks.gate.needs = ['service'];
  repo.commit({ 'proof.yaml': JSON.stringify(doc) });
  const result = repo.cli(['why', 'gate'], env, join(repo.path, 'src'));
  expect(result.code).toBe(0);
  expect(result.out.split('\n')[0]).toBe(repo.cli(['plan'], env).out.trim());
  expect(result.out).toContain(`file src/a 100644 ${repo.git('rev-parse', 'HEAD:src/a')}`);
  expect(result.out).toContain('member config.json selected 100644 ');
  expect(result.out).toContain('env PROOF_WHY_MODE\n');
  expect(result.out).toMatch(/declaration [a-f0-9]{64}/);
  expect(result.out).toContain('no proof for this task');
  expect(existsSync(join(repo.path, 'executed'))).toBe(false);
  const unknown = repo.cli(['why', 'missing'], env);
  expect(unknown.code).toBe(2);
  expect(unknown.err).toContain("undeclared task 'missing'");
  for (const args of [[], ['gate', 'extra'], ['--json']]) {
    expect(repo.cli(['why', ...args], env).err).toBe('proof: usage: proof why <task>\n');
  }
}, 30_000);

function record(repo: Repo, env: Record<string, string>, outcome = 'green') {
  const result = repo.cli(['record', 'gate', '--outcome', outcome], env);
  expect(result.code).toBe(0);
}
function changes(out: string) {
  return out.split('\n').filter((line) => /^(added|removed|changed) /.test(line));
}

test('why compares only changed paths against the newest surviving proof across keys', () => {
  const { repo, env } = fixture();
  record(repo, env);
  repo.commit({ 'src/a': 'new' });
  let result = repo.cli(['why', 'gate'], env);
  expect(result.code).toBe(0);
  expect(changes(result.out)).toEqual(['changed file src/a']);
  record(repo, env);
  const newest = repo.git('rev-parse', 'HEAD');
  repo.commit({ 'src/b': 'later' });
  record(repo, env, 'incomplete');
  result = repo.cli(['why', 'gate'], env);
  expect(changes(result.out)).toEqual(['changed file src/b']);
  expect(result.out).toContain(`comparison: ${newest} on `);
  expect(result.out).toContain(`file src/a 100644 ${repo.git('rev-parse', 'HEAD:src/a')}`);
  const clean = repo.git('status', '--porcelain');
  expect(clean).toBe('');
}, 30_000);

test('why compares glob additions, removals and executable mode', () => {
  const { repo, env } = fixture();
  record(repo, env);
  repo.git('rm', 'src/a');
  repo.commit({ 'src/c': 'three', 'src/excluded': 'changed but excluded' });
  expect(repo.cli(['why', 'gate'], env).out).not.toContain('src/excluded');
  expect(changes(repo.cli(['why', 'gate'], env).out)).toEqual([
    'removed file src/a',
    'added file src/c',
  ]);
  record(repo, env);
  repo.git('update-index', '--chmod=+x', 'src/b');
  repo.git('commit', '-qm', 'mode');
  repo.git('checkout-index', '-f', 'src/b');
  expect(changes(repo.cli(['why', 'gate'], env).out)).toEqual(['changed file src/b']);
}, 30_000);

test('why compares declaration meaning and includes member modes', () => {
  const { repo, env } = fixture();
  record(repo, env);
  const doc = JSON.parse(repo.git('show', 'HEAD:proof.yaml'));
  doc.tasks.gate.run = 'true';
  repo.commit({ 'proof.yaml': JSON.stringify(doc) });
  const result = repo.cli(['why', 'gate'], env);
  expect(result.out).toContain('declaration changed');
  expect(changes(result.out)).toEqual([]);
  record(repo, env);
  repo.git('update-index', '--chmod=+x', 'config.json');
  repo.git('commit', '-qm', 'mode');
  repo.git('checkout-index', '-f', 'config.json');
  expect(changes(repo.cli(['why', 'gate'], env).out)).toEqual([
    'changed member config.json selected',
  ]);
}, 30_000);

test('offline newest lookup uses only local history and announces fallback once', () => {
  const { repo, env } = fixture();
  record(repo, env);
  repo.commit({ 'src/a': 'offline' });
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  const offline = { ...env, PROOF_STORE: `postgres://proof@127.0.0.1:${port}/proof` };
  const result = repo.cli(['why', 'gate'], offline);
  expect(result.code).toBe(0);
  expect(changes(result.out)).toEqual(['changed file src/a']);
  expect(result.err.trim().split('\n')).toEqual([
    expect.stringMatching(/^store unreachable \(.+\); using this machine's own proofs$/),
  ]);
  const fresh = mkdtempSync(join(tmpdir(), 'proof-why-fresh-'));
  states.push(fresh);
  const empty = repo.cli(['why', 'gate'], { ...offline, PROOF_STATE_DIR: fresh });
  expect(empty.code).toBe(0);
  expect(empty.out).toContain('no proof for this task');
}, 30_000);

import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Repo } from './support/repo';

const repos: Repo[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.close();
});
function fixture() {
  const r = new Repo();
  repos.push(r);
  const marker = join(r.path, '.git/executed');
  const run = `cat assets/a assets/b > '${marker}'`;
  const doc = {
    version: 1,
    project: 'delivered',
    tasks: {
      read: { run, inputs: ['source'] },
      negated: { run, inputs: ['source', 'assets/**', '!assets/**'] },
    },
  };
  r.commit({
    'proof.yaml': JSON.stringify(doc),
    source: 'source',
    'assets/a': 'a',
    'assets/b': 'b',
  });
  const raw = (args: string[]) => r.cli(args, { PROOF_STATE_DIR: join(r.path, '.git/state') });
  const cli = (args: string[]) => {
    const result = raw(args);
    expect(result.code, result.err + result.out).toBe(0);
    return result.out;
  };
  const plan = () =>
    JSON.parse(cli(['plan', '--json'])) as { task: string; key: string; state: string }[];
  return { r, doc, marker, raw, cli, plan };
}

test('root delivery ignores negation and preserves keys and proofs across adoption and committed edits', () => {
  const { r, doc, marker, cli, plan } = fixture();
  const before = plan().map((row) => row.key);
  r.commit({ 'proof.yaml': JSON.stringify({ ...doc, delivered: ['assets/**'] }) });
  expect(plan().map((row) => row.key)).toEqual(before);
  expect(cli(['run', '--jobs', '2'])).toContain('proof published');
  expect(readFileSync(marker, 'utf8')).toBe('ab');
  const from = r.git('rev-parse', 'HEAD');
  const to = r.commit({ 'assets/a': 'A' });
  expect(plan().map((row) => row.key)).toEqual(before);
  expect(plan().every((row) => row.state === 'PROVEN')).toBe(true);
  expect(r.check([{ name: 'delivery edit', from, to, expect: [] }]).out).toContain('PASS');
  cli(['run']);
  expect(readFileSync(marker, 'utf8')).toBe('ab');
  cli(['run', '--fresh']);
  expect(readFileSync(marker, 'utf8')).toBe('Ab');
});

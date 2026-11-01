import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

const repo = new Repo();
const outside = mkdtempSync(join(tmpdir(), 'proof-help-outside-'));
afterAll(() => {
  repo.close();
  rmSync(outside, { recursive: true, force: true });
});

const usages: Record<string, string> = {
  check: 'usage: proof check <cases.yaml>',
  plan: 'usage: proof plan [--set <name>] [--json]',
  record: 'usage: proof record <task> --outcome green|red|incomplete [--seconds N]',
  lint: 'usage: proof lint',
  run: 'usage: proof run [--fresh | --staged] [--jobs N] [--tasks <id> ... | --set <name>]',
  doctor: 'usage: proof doctor',
  status: 'usage: proof status --ref <ref> [--set <name>] [--json]',
  why: 'usage: proof why <task>',
  stats: 'usage: proof stats [--set <name>] [--since Nd]',
  flakes: 'usage: proof flakes [--since Nd]',
  invalidate: 'usage: proof invalidate --task <t> [--key k | --all]',
  help: 'usage: proof help [<command>]',
};

for (const args of [
  ['check'],
  ['check', 'a', 'b'],
  ['record'],
  ['plan', '--json', '--help'],
  ['doctor', '--help', 'x'],
  ['check', '-h', 'x'],
  ['run', '--tasks', '--help'],
]) {
  test(`preserves usage error: ${args.join(' ')}`, () => {
    expect(repo.cli(args)).toEqual({ code: 2, out: '', err: `proof: ${usages[args[0] ?? '']}\n` });
  });
}

test('non-help calls outside git still fail at git discovery', () => {
  const result = repo.cli(['plan', '--nope'], {}, outside);
  expect(result.code).toBe(2);
  expect(result.out).toBe('');
  expect(result.err).toContain('not a git repository');
  expect(result.err).not.toContain('usage:');
});

import { afterAll, expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
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
  stats: 'usage: proof stats [--set <name>] [--since Nd] [--by <dimension>] [--json]',
  flakes: 'usage: proof flakes [--since Nd]',
  invalidate: 'usage: proof invalidate --task <t> [--key k | --all]',
  help: 'usage: proof help [<command>]',
};

const declared = {
  'proof.yaml root fields': [
    'version',
    'project',
    'inputs',
    'tasks',
    'include',
    'generate',
    'coverage',
    'exempt',
    'providers',
    'lanes',
    'dimensions',
    'unkeyed',
  ],
  'Task fields': ['run', 'inputs', 'env', 'links', 'needs', 'sets', 'lane', 'dimensions', 'keyed'],
  'Provider fields': ['start', 'stop', 'lane'],
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

for (const cwd of [repo.path, outside]) {
  test(`general help aliases without configuration in ${cwd}`, () => {
    const canonical = repo.cli([], {}, cwd);
    expect(canonical.code).toBe(0);
    expect(canonical.err).toBe('');
    for (const args of [['--help'], ['-h'], ['help']])
      expect(repo.cli(args, {}, cwd)).toEqual(canonical);
    expect(canonical.out).toBe(repo.cli([]).out);
    for (const name of Object.keys(usages))
      expect(canonical.out).toMatch(new RegExp(`^  ${name} +\\S.+$`, 'm'));
    for (const [section, fields] of Object.entries(declared)) {
      const body = canonical.out.split(`${section}:\n`)[1]?.split('\n\n')[0] ?? '';
      for (const field of fields) expect(body).toMatch(new RegExp(`\\b${field}:`));
    }
    for (const text of [
      'version: 1',
      'solo',
      '$name',
      "'!'",
      '{path, json: [members]}',
      '{path, dotenv-keys: true}',
      '{dotenv, exclude?: [names]}',
      '{imports-of: entry}',
      '{maestro: flow}',
      'PROOF_STORE',
      'PROOF_STATE_DIR',
      'XDG_CONFIG_HOME',
      'XDG_STATE_HOME',
      'HOME',
      'PROOF_LANES',
      'PROOF_LANE_SLOT',
      'PROOF_PROVIDER_ENV',
      'PROOF_DECLARATIONS',
      '0: successful',
      '1: run red/incomplete',
      '2: usage/configuration/declaration/store/log error',
      '130: SIGINT',
      '143: SIGTERM',
    ])
      expect(canonical.out).toContain(text);
  });

  test(`every dispatch command has help and aliases in ${cwd}`, () => {
    const diagnostic = repo.cli(['nope'], {}, cwd).err;
    const names = diagnostic.match(/^commands: (.+)$/m)?.[1]?.split(', ') ?? [];
    expect([...names].sort()).toEqual(Object.keys(usages).sort());
    for (const name of names) {
      const result = repo.cli([name, '--help'], {}, cwd);
      expect(result.code).toBe(0);
      expect(result.err).toBe('');
      const lines = result.out.trim().split('\n');
      expect(lines[0]).toBe(usages[name]);
      expect(lines[1]?.trim().length).toBeGreaterThan(0);
      expect(result.out.match(/^usage: /gm)).toHaveLength(1);
      expect(repo.cli([name, '-h'], {}, cwd)).toEqual(result);
      expect(repo.cli(['help', name], {}, cwd)).toEqual(result);
    }
  });

  test(`unknown commands name the error and valid dispatch names in ${cwd}`, () => {
    for (const args of [['nope'], ['help', 'nope']]) {
      const result = repo.cli(args, {}, cwd);
      expect(result.code).toBe(2);
      expect(result.out).toBe('');
      expect(result.err).toContain("proof: unknown command 'nope'\n");
      const names = result.err.match(/^commands: (.+)$/m)?.[1]?.split(', ') ?? [];
      expect(names.sort()).toEqual(Object.keys(usages).sort());
    }
    expect(repo.cli(['help', 'run', 'extra'], {}, cwd)).toEqual({
      code: 2,
      out: '',
      err: `proof: ${usages.help}\n`,
    });
  });
}

test('installed reference paths resolve from a relocated module with spaces', () => {
  const copy = mkdtempSync(join(tmpdir(), 'proof help copy '));
  try {
    cpSync(new URL('../src', import.meta.url), join(copy, 'src'), { recursive: true });
    cpSync(new URL('../package.json', import.meta.url), join(copy, 'package.json'));
    mkdirSync(join(copy, 'docs'));
    for (const path of ['README.md', 'docs/commands.md']) writeFileSync(join(copy, path), 'stub');
    const result = Bun.spawnSync([process.execPath, '--no-env-file', join(copy, 'src/cli.ts')], {
      cwd: outside,
      env: { HOME: copy, PROOF_STORE: 'invalid' },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe('');
    const paths = [...result.stdout.toString().matchAll(/^ {2}(?:README|Commands): (.+)$/gm)].map(
      (match) => match[1] as string,
    );
    expect(paths).toHaveLength(2);
    for (const [i, path] of paths.entries()) {
      expect(isAbsolute(path)).toBe(true);
      expect(existsSync(path)).toBe(true);
      expect(realpathSync(path)).toBe(
        realpathSync(join(copy, i ? 'docs/commands.md' : 'README.md')),
      );
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

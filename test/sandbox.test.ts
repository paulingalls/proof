import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'proof-links-'));
  dirs.push(dir);
  return dir;
}
function fixture() {
  const repo = Repo.from('links', (r) =>
    r.commit({
      'main.ts': "import value from 'example'; if (value !== 1) process.exit(1);",
      lock: 'locked',
      '.gitignore': '.venv/\n',
    }),
  );
  repos.push(repo);
  const env = { PROOF_STATE_DIR: directory(), TMPDIR: directory() };
  const cli = (...args: string[]) => repo.cli(args, env);
  const declare = (
    links?: unknown,
    run = `'${process.execPath}' --no-install main.ts`,
    inputs = ['main.ts', 'lock'],
  ) =>
    repo.commit({
      'proof.yaml': JSON.stringify({
        version: 1,
        project: 'links',
        tasks: {
          linked: { run, inputs, ...(links === undefined ? {} : { links }) },
          unchanged: { run: 'true', inputs: ['lock'] },
        },
      }),
    });
  const run = () => cli('run', '--tasks', 'linked');
  return { repo, env, cli, declare, run };
}
function rows(env: { PROOF_STATE_DIR: string }, table: string) {
  const db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
  try {
    return db.query(`SELECT * FROM ${table} ORDER BY rowid`).all();
  } finally {
    db.close();
  }
}

test('links expose installed packages, report trust, preserve proofs across installed-byte changes', () => {
  const { repo, env, cli, declare, run } = fixture();
  declare();
  expect(run().code).toBe(1);
  mkdirSync(join(repo.path, 'node_modules/.bin'));
  symlinkSync('../example/index.js', join(repo.path, 'node_modules/.bin/example'));
  declare(['node_modules']);
  for (const args of [['plan'], ['plan', '--json']]) {
    const plan = cli(...args);
    expect(plan.code).toBe(0);
    expect(plan.out).toContain('trusted links: node_modules');
  }
  const result = run();
  expect(result.code).toBe(0);
  expect(result.out).toContain('green linked; proof published');
  expect(rows(env, 'proofs')).toHaveLength(1);
  expect(readdirSync(env.TMPDIR)).toEqual([]);
  expect(existsSync(join(repo.path, 'node_modules/example/index.js'))).toBe(true);
  repo.write('node_modules/example/index.js', 'export default 2;');
  expect(cli('plan', '--json').out).toContain('trusted links: node_modules');
  expect(run().out).toContain('PROVEN linked');
  rmSync(join(repo.path, 'node_modules'), { recursive: true });
  expect(cli('plan').code).toBe(0);
  expect(run().out).toContain('PROVEN linked');
});

test('missing and dangling links fail before execution and leave no records or sandbox', () => {
  const { repo, env, declare, run } = fixture();
  const marker = join(directory(), 'ran');
  declare(['missing-dir'], `touch '${marker}'`);
  for (const dangling of [false, true]) {
    if (dangling) symlinkSync('absent', join(repo.path, 'missing-dir'));
    const result = run();
    expect(result.code).toBe(2);
    expect(result.err).toContain('missing-dir');
    expect(existsSync(marker)).toBe(false);
    expect(rows(env, 'results')).toEqual([]);
    expect(rows(env, 'proofs')).toEqual([]);
    expect(readdirSync(env.TMPDIR)).toEqual([]);
  }
});

test('invalid paths and collisions fail without commands or checkout writes', () => {
  const { repo, env, declare, run } = fixture();
  const marker = join(directory(), 'ran');
  repo.commit({ 'src/file': 'keep' });
  for (const links of [
    'node_modules',
    [1],
    [''],
    ['/tmp'],
    ['../x'],
    ['./x'],
    ['x//y'],
    ['x/.git/y'],
    ['x/'],
  ]) {
    declare(links, `touch '${marker}'`);
    const result = run();
    expect(result.code).toBe(2);
    expect(result.err).toContain('linked');
    expect(result.err).toContain('link');
  }
  for (const links of [['main.ts'], ['node_modules', 'node_modules/example'], ['src']]) {
    declare(
      links,
      `touch '${marker}'`,
      links.length === 1 && links[0] === 'src' ? ['main.ts', 'src/file'] : undefined,
    );
    const result = run();
    expect(result.code).toBe(2);
    expect(result.err).toContain('link');
    expect(readdirSync(env.TMPDIR)).toEqual([]);
  }
  expect(existsSync(marker)).toBe(false);
  expect(repo.git('show', 'HEAD:main.ts')).toContain('import value');
  expect(readFileSync(join(repo.path, 'node_modules/example/index.js'), 'utf8')).toBe(
    'export default 1;',
  );
});

test('check keys use normalized declarations without accessing link targets', () => {
  const { repo, declare } = fixture();
  const a = declare();
  const b = declare([]);
  const c = declare(['node_modules']);
  const d = declare(['.venv']);
  const e = declare(['node_modules', '.venv']);
  const f = declare(['.venv', 'node_modules', '.venv']);
  rmSync(join(repo.path, 'node_modules'), { recursive: true });
  const result = repo.check([
    { name: 'empty', from: a, to: b, expect: [] },
    { name: 'add', from: b, to: c, expect: ['linked'] },
    { name: 'change', from: c, to: d, expect: ['linked'] },
    { name: 'add second', from: d, to: e, expect: ['linked'] },
    { name: 'normalize', from: e, to: f, expect: [] },
  ]);
  expect(result.code).toBe(0);
});

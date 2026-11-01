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
import { basename, join } from 'node:path';
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
  symlinkSync('../removed/cli.js', join(repo.path, 'node_modules/.bin/removed'));
  repo.write('node_modules/.bun/installed/index.js', 'export default 1;');
  symlinkSync('.bun/installed', join(repo.path, 'node_modules/isolated'));
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

for (const [name, declared] of [
  ['example', false],
  ['@app/shared', false],
  ['@app/shared', true],
] as const) {
  test(`workspace escape ${name}, declared ${declared} runs green without publishing or reusing an old proof`, () => {
    const { repo, env, cli, declare, run } = fixture();
    repo.commit({
      'packages/shared/index.js': 'export default 1;',
      ...(declared
        ? {
            'package.json': '{"workspaces":["packages/*"]}',
            'packages/declared/package.json': JSON.stringify({ name }),
          }
        : {}),
    });
    repo.write('main.ts', `import value from '${name}'; if (value !== 1) process.exit(1);`);
    declare(['node_modules']);
    const target = join(repo.path, 'node_modules', name);
    if (name.startsWith('@')) {
      repo.write(`node_modules/${name}/index.js`, 'export default 1;');
    }
    expect(run().code).toBe(0);
    const proof = rows(env, 'proofs');
    expect(proof).toHaveLength(1);
    rmSync(target, { recursive: true });
    symlinkSync(name.startsWith('@') ? '../../packages/shared' : '../packages/shared', target);
    const plan = cli('plan', '--json');
    expect(plan.code).toBe(0);
    const decision = JSON.parse(plan.out).find((row: { task: string }) => row.task === 'linked');
    expect(decision.state).toBe('RUN');
    expect(decision.reason).toContain(`node_modules/${name}`);
    expect(decision.reason).toContain(join(repo.path, 'packages/shared'));
    expect(decision.reason).toContain('escape');
    const result = run();
    expect(result.code).toBe(0);
    expect(result.out).toContain('green linked; no proof published:');
    expect(result.out).toContain(`node_modules/${name}`);
    expect(rows(env, 'results')).toHaveLength(2);
    expect(rows(env, 'proofs')).toEqual(proof);
    repo.write('main.ts', `import value from '${name}'; process.exit(value);`);
    const dirty = cli('plan');
    expect(dirty.out).toContain('dirty input');
    expect(dirty.out).toContain('escape');
    repo.git('restore', 'main.ts');
    repo.write('proof.yaml', `${repo.git('show', 'HEAD:proof.yaml')}\n`);
    expect(cli('plan').out).toContain('escape');
  });
}

test('both pre-run and post-run escape observations prevent publication', () => {
  const { repo, env, declare, run } = fixture();
  repo.commit({
    'package.json': '{"workspaces":["packages/*"]}',
    'packages/shared/package.json': '{"name":"workspace"}',
    'packages/shared/index.js': 'export default 1;',
    'wrong/index.js': 'export default 1;',
  });
  const target = join(repo.path, 'node_modules/workspace');
  symlinkSync('../packages/shared', target);
  declare(['node_modules'], `rm '${target}'; ln -s ../wrong '${target}'`);
  let result = run();
  expect(result.code).toBe(0);
  expect(result.out).toContain('no proof published:');
  expect(result.out).toContain('node_modules/workspace');
  expect(rows(env, 'proofs')).toEqual([]);
  declare(['node_modules'], `rm '${target}'; ln -s ../packages/shared '${target}'`);
  result = run();
  expect(result.code).toBe(0);
  expect(result.out).toContain('no proof published:');
  expect(rows(env, 'proofs')).toEqual([]);
  expect(rows(env, 'results')).toHaveLength(2);
});

for (const relativeEntry of [false, true]) {
  test(`Python ${relativeEntry ? 'relative' : 'absolute'} pth paths cannot publish workspace proof`, () => {
    const { repo, env, cli, declare, run } = fixture();
    repo.commit({
      'package.json': '{"workspaces":["packages/*"]}',
      'packages/shared/package.json': '{"name":"@app/shared"}',
      'packages/shared/index.js': 'export default 1;',
    });
    const pth = '.venv/lib/python3.13/site-packages/local.pth';
    repo.write(
      pth,
      relativeEntry ? '../../../../packages/shared\n' : `${repo.path}/packages/shared\n`,
    );
    declare(['.venv'], `cat ${pth}`);
    const plan = cli('plan', '--json');
    expect(plan.code).toBe(0);
    expect(plan.out).toContain('escape');
    expect(plan.out).toContain(pth);
    expect(plan.out).toContain(join(repo.path, 'packages/shared'));
    const result = run();
    expect(result.code).toBe(0);
    expect(result.out).toContain('green linked; no proof published:');
    expect(result.out).toContain(pth);
    expect(rows(env, 'results')).toHaveLength(1);
    expect(rows(env, 'proofs')).toEqual([]);
  });
}

test('Python site rules ignore code, stale entries and paths outside the repo or inside the link', () => {
  const { repo, env, cli, declare, run } = fixture();
  const sibling = `${repo.path}-sibling`;
  mkdirSync(sibling);
  dirs.push(sibling);
  const site = '.venv/lib/python3.13/site-packages';
  repo.write(`${site}/installed/keep`, 'installed');
  repo.write(
    `${site}/local.pth`,
    [
      '',
      '# comment',
      'import _virtualenv',
      'import\tignored',
      'installed',
      `${repo.path}/missing`,
      sibling,
      '',
    ].join('\n'),
  );
  symlinkSync('lib', join(repo.path, '.venv/lib64'));
  declare(['.venv'], `cat ${site}/local.pth`);
  const result = run();
  expect(result.code).toBe(0);
  expect(result.out).toContain('green linked; proof published');
  expect(result.out).toContain('trusted links: .venv');
  expect(rows(env, 'proofs')).toHaveLength(1);
  expect(cli('plan').out).toContain('PROVEN linked');
});

test('a regular file can be linked as an untracked dependency', () => {
  const { repo, env, declare, run } = fixture();
  repo.write('.git/info/exclude', '/node_modules/\n/.venv\n');
  repo.write('.venv', 'dependency');
  declare(['.venv'], 'test "$(cat .venv)" = dependency');
  const result = run();
  expect(result.code).toBe(0);
  expect(rows(env, 'proofs')).toHaveLength(1);
});

for (const via of ['tracked directory', 'ignored symlink to it']) {
  test(`a link reaching tracked source through a ${via} never publishes`, () => {
    const { repo, env, cli, declare, run } = fixture();
    repo.commit({
      'src/a.txt': 'ok',
      ...(via === 'tracked directory' ? {} : { '.gitignore': 'deps\n' }),
    });
    if (via !== 'tracked directory') symlinkSync('src', join(repo.path, 'deps'));
    const link = via === 'tracked directory' ? 'src' : 'deps';
    declare(['node_modules', link], `grep -q ok ${link}/a.txt`);
    const result = run();
    expect(result.out).toContain('green linked; no proof published:');
    expect(result.out).toContain("tracked 'src/a.txt'");
    expect(rows(env, 'proofs')).toEqual([]);
    expect(cli('plan').out).toContain('RUN linked');
    repo.commit({ 'src/a.txt': 'bad' });
    const changed = run();
    expect(changed.code).toBe(1);
    expect(changed.out).toContain('red linked');
    expect(changed.out).not.toContain('PROVEN linked');
  });
}

for (const python of [false, true]) {
  test(`declared roots share installed targets; Python=${python}`, () => {
    const { repo, env, cli, declare, run } = fixture();
    repo.commit({ '.gitignore': 'a/node_modules/\n.venv/\nnode_modules-other/\n' });
    repo.write('node_modules/.bun/example/index.js', 'installed');
    const child = 'a/node_modules/example';
    const pth = '.venv/lib/python3.13/site-packages/local.pth';
    if (python) repo.write(pth, '../../../../node_modules/.bun/example\n');
    else {
      mkdirSync(join(repo.path, 'a/node_modules'), { recursive: true });
      symlinkSync('../../node_modules/.bun/example', join(repo.path, child));
    }
    declare(
      [python ? '.venv' : 'a/node_modules', 'node_modules'],
      python ? `cat ${pth}` : `grep -q installed ${child}/index.js`,
    );
    expect(run().out).toContain('green linked; proof published');
    const proof = rows(env, 'proofs');
    expect(proof).toHaveLength(1);
    expect(cli('plan', '--json').out).toContain('"state":"PROVEN"');
    if (python) return;
    repo.write('node_modules-other/index.js', 'installed');
    rmSync(join(repo.path, child));
    symlinkSync('../../node_modules-other', join(repo.path, child));
    const plan = cli('plan', '--json');
    expect(plan.out).toContain('"state":"RUN"');
    expect(plan.out).toContain(`link escape '${child}'`);
    expect(plan.out).toContain(join(repo.path, 'node_modules-other'));
    const result = run();
    expect(result.code).toBe(0);
    expect(result.out).toContain('green linked; no proof published:');
    expect(rows(env, 'proofs')).toEqual(proof);
  });
}

for (const root of ['node_modules', 'a/node_modules']) {
  test(`cross-root links still refuse tracked content in ${root}`, () => {
    const { repo, env, cli, declare, run } = fixture();
    repo.commit({ '.gitignore': 'a/node_modules/\n' });
    const other = root === 'node_modules' ? 'a/node_modules' : 'node_modules';
    repo.write(`${root}/payload/index.js`, 'tracked');
    repo.git('add', '-f', `${root}/payload/index.js`);
    repo.git('commit', '-qm', 'tracked payload');
    mkdirSync(join(repo.path, other), { recursive: true });
    symlinkSync(
      root === 'node_modules' ? '../../node_modules/payload' : '../a/node_modules/payload',
      join(repo.path, other, 'cross'),
    );
    declare(['a/node_modules', 'node_modules'], `grep -q tracked ${other}/cross/index.js`);
    const result = run();
    expect(result.code).toBe(0);
    expect(result.out).toContain('green linked; no proof published:');
    expect(result.out).toContain(`reaches tracked '${root}/payload/index.js'`);
    expect(result.out).not.toContain('link escape');
    expect(rows(env, 'proofs')).toEqual([]);
    expect(cli('plan').out).toContain('RUN linked');
  });
}

test('selected committed symlinks preserve target identity and checkout isolation', () => {
  const { repo, env, cli, declare, run } = fixture();
  repo.commit({ 'a/keep': '', first: 'same', second: 'same' });
  const link = join(repo.path, 'a/link');
  symlinkSync('../first', link);
  const command = 'test -L a/link && test "$(cat a/link)" = same';
  declare([], command, ['a/link', 'first', 'second']);
  const decision = () =>
    JSON.parse(cli('plan', '--json').out).find((row: { task: string }) => row.task === 'linked');
  const before = decision().key;
  expect(run().out).toContain('green linked; proof published');
  expect(decision().state).toBe('PROVEN');
  rmSync(link);
  symlinkSync('../second', link);
  repo.git('add', 'a/link');
  repo.git('commit', '-qm', 'retarget identical bytes');
  expect(decision().key).not.toBe(before);
  expect(decision().state).toBe('RUN');
  expect(run().out).toContain('green linked; proof published');
  expect(decision().state).toBe('PROVEN');
  declare(
    [],
    `rm '${link}'; ln -s ../first '${link}'; test "$(readlink a/link)" = ../second && ${command}`,
    ['a/link', 'first', 'second'],
  );
  const result = run();
  expect(result.code).toBe(0);
  expect(result.out).toContain("no proof published: new dirty path 'a/link'");
  expect(rows(env, 'proofs')).toHaveLength(2);
});

for (const kind of ['absolute', 'leaves repo', 'dirty']) {
  test(`selected symlink rejects ${kind} targets before execution`, () => {
    const { repo, env, declare, run } = fixture();
    repo.commit({ target: 'same' });
    const marker = join(directory(), 'ran');
    const target =
      kind === 'absolute'
        ? join(repo.path, 'target')
        : kind === 'leaves repo'
          ? `../${basename(repo.path)}/target`
          : 'target';
    const link = join(repo.path, 'link');
    symlinkSync(target, link);
    declare([], `touch '${marker}'`, ['link', 'target']);
    if (kind === 'dirty') {
      rmSync(link);
      symlinkSync('other', link);
    }
    const result = run();
    expect(result.code).toBe(2);
    expect(result.err).toContain("selected path 'link': symlink");
    if (kind !== 'dirty') expect(result.err).toContain(target);
    expect(existsSync(marker)).toBe(false);
    expect(rows(env, 'results')).toEqual([]);
    expect(rows(env, 'proofs')).toEqual([]);
    expect(readdirSync(env.TMPDIR)).toEqual([]);
  });
}

for (const retargeted of [false, true]) {
  test(`staged provider tasks with a committed selected symlink; retargeted=${retargeted}`, () => {
    const { repo, env, cli } = fixture();
    repo.commit({ target: 'selected' });
    const link = join(repo.path, 'link');
    symlinkSync('target', link);
    repo.commit({
      'proof.yaml': JSON.stringify({
        version: 1,
        project: 'links',
        providers: { stack: { start: 'true' } },
        tasks: {
          linked: {
            run: 'test -L link && grep -q selected link',
            inputs: ['link', 'target'],
            needs: ['stack'],
          },
        },
      }),
    });
    if (retargeted) {
      rmSync(link);
      symlinkSync('other', link);
    }
    const result = cli('run', '--staged', '--tasks', 'linked');
    expect(result.code).toBe(retargeted ? 2 : 0);
    if (retargeted) expect(result.err).toContain("selected path 'link': symlink");
    else expect(result.out).toContain('green linked; proof published');
    expect(rows(env, 'proofs')).toHaveLength(retargeted ? 0 : 1);
  });
}

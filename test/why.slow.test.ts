import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../src/declarations';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const states: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const path of states.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture(inputs: Task['inputs'] = ['src/**']) {
  const repo = new Repo();
  repos.push(repo);
  repo.commit({
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'why',
      tasks: {
        gate: { run: 'true', inputs, env: ['PROOF_WHY_MODE'] },
      },
    }),
    'src/a.ts': 'export default 1;',
    'src/b.ts': 'export default 2;',
    'config.json': '{"selected":1}',
    '.gitignore': 'src/ignored\n',
  });
  const path = mkdtempSync(join(tmpdir(), 'proof-why-'));
  states.push(path);
  const env = { PROOF_STATE_DIR: path };
  expect(repo.cli(['record', 'gate', '--outcome', 'green'], env).code).toBe(0);
  return { repo, env };
}
function changes(out: string) {
  return out.split('\n').filter((line) => /^(added|removed|changed) /.test(line));
}

test('working bytes include staged/unstaged edits, untracked additions, deletion and binary bytes', () => {
  const { repo, env } = fixture(['src/**', { path: 'config.json', json: ['selected'] }]);
  repo.write('src/a.ts', 'staged');
  repo.git('add', 'src/a.ts');
  repo.write('src/a.ts', 'on disk');
  repo.write('src/c.ts', 'new');
  repo.write('src/ignored', 'ignored');
  writeFileSync(join(repo.path, 'src/binary'), Buffer.from([0, 255, 1]));
  rmSync(join(repo.path, 'src/b.ts'));
  repo.write('config.json', '{"selected":2}');
  const before = repo.git('status', '--porcelain');
  const result = repo.cli(['why', 'gate'], env);
  expect(result.code).toBe(0);
  expect(result.out.split('\n')[0]).toBe(repo.cli(['plan'], env).out.split('\n')[0]);
  expect(changes(result.out)).toEqual([
    'changed file src/a.ts',
    'removed file src/b.ts',
    'added file src/binary',
    'added file src/c.ts',
    'changed member config.json selected',
  ]);
  expect(result.out).toContain(
    `file src/a.ts 100644 ${repo.git('hash-object', '--no-filters', 'src/a.ts')}`,
  );
  expect(result.out).toContain(
    `file src/binary 100644 ${repo.git('hash-object', '--no-filters', 'src/binary')}`,
  );
  expect(repo.git('status', '--porcelain')).toBe(before);
});

test('working closure follows new dependencies; a broken closure never invents removals', () => {
  const { repo, env } = fixture([{ 'imports-of': 'src/a.ts' }]);
  repo.commit({ 'src/a.ts': "import './b';" });
  expect(repo.cli(['record', 'gate', '--outcome', 'green'], env).code).toBe(0);
  repo.write('src/a.ts', "import './c';");
  repo.write('src/c.ts', 'export default 3;');
  expect(changes(repo.cli(['why', 'gate'], env).out)).toEqual([
    'changed file src/a.ts',
    'removed file src/b.ts',
    'added file src/c.ts',
  ]);
  repo.write('src/a.ts', "import './missing';");
  const broken = repo.cli(['why', 'gate'], env);
  expect(broken.code).toBe(0);
  expect(broken.out).toContain('unresolved import');
  expect(changes(broken.out)).toEqual(['changed file src/a.ts']);
});

test('unavailable selected entries preserve valid parts without fabricated removals', () => {
  const { repo, env } = fixture(['src/**', { path: 'config.json', json: ['selected'] }]);
  rmSync(join(repo.path, 'src/a.ts'));
  symlinkSync('b.ts', join(repo.path, 'src/a.ts'));
  repo.write('config.json', '{');
  const result = repo.cli(['why', 'gate'], env);
  expect(result.code).toBe(0);
  expect(result.out).toContain("unavailable input 'src/a.ts'");
  expect(result.out).toContain("input 'config.json': invalid JSON");
  expect(result.out).toContain('file src/b.ts');
  expect(changes(result.out)).toEqual([]);
  rmSync(join(repo.path, 'src'), { recursive: true });
  const deleted = repo.cli(['why', 'gate'], env);
  expect(deleted.code).toBe(0);
  expect(deleted.out).toContain("unmatched input 'src/**'");
  expect(changes(deleted.out)).toEqual(['removed file src/a.ts', 'removed file src/b.ts']);
});

test('legacy proofs migrate without inventing env metadata and can be replaced', () => {
  const { repo, env } = fixture();
  const db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
  try {
    db.exec('ALTER TABLE proofs DROP COLUMN env_hashes; UPDATE schema_version SET version = 1');
    const unchanged = repo.cli(['why', 'gate'], env);
    expect(unchanged.out).toContain('env comparison unavailable');
    expect(unchanged.out).not.toContain('no proof has these dimension values');
    expect(unchanged.out).toContain('no comparable inputs changed');
    repo.commit({ 'src/a.ts': 'changed' });
    for (let i = 0; i < 2; i++) {
      const result = repo.cli(['why', 'gate'], env);
      expect(result.code).toBe(0);
      expect(result.out).toContain('env comparison unavailable');
      expect(changes(result.out)).toEqual(['changed file src/a.ts']);
    }
    expect(db.query('SELECT version FROM schema_version').all()).toEqual([{ version: 2 }]);
    expect(db.query('SELECT env_hashes FROM proofs').all()).toEqual([{ env_hashes: null }]);
    expect(repo.cli(['record', 'gate', '--outcome', 'green'], env).code).toBe(0);
    const result = repo.cli(['why', 'gate'], env);
    expect(result.out).not.toContain('env comparison unavailable');
    expect(result.out).toContain('no inputs changed');
    db.exec('UPDATE proofs SET env_hashes = NULL');
    expect(repo.cli(['record', 'gate', '--outcome', 'green'], env).code).toBe(0);
    const nulls = db.query('SELECT 1 FROM proofs WHERE env_hashes IS NULL ORDER BY rowid DESC');
    expect(nulls.all()).toEqual([{ 1: 1 }]);
  } finally {
    db.close();
  }
});

test('unreachable proof commit prints current parts only; available invalid history fails loudly', () => {
  const { repo, env } = fixture();
  const base = repo.git('rev-parse', 'HEAD');
  repo.git('checkout', '-qb', 'temporary');
  const temporary = repo.commit({ 'src/a.ts': 'temporary' });
  expect(repo.cli(['record', 'gate', '--outcome', 'green'], env).code).toBe(0);
  repo.git('checkout', '--detach', base);
  repo.git('branch', '-D', 'temporary');
  repo.git('reflog', 'expire', '--expire=now', '--all');
  repo.git('gc', '--prune=now');
  const missing = Bun.spawnSync(['git', 'cat-file', '-e', `${temporary}^{commit}`], {
    cwd: repo.path,
  });
  expect(missing.exitCode).not.toBe(0);
  const result = repo.cli(['why', 'gate'], env);
  expect(result.code).toBe(0);
  expect(result.out).toContain(`proof commit unavailable: ${temporary}`);
  expect(result.out).toContain('file src/a.ts');
  expect(changes(result.out)).toEqual([]);
  const invalid = repo.commit({ 'proof.yaml': 'version: 99' });
  repo.git('checkout', '--detach', base);
  const db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
  try {
    db.query('UPDATE results SET "commit" = ?').run(invalid);
  } finally {
    db.close();
  }
  const broken = repo.cli(['why', 'gate'], env);
  expect(broken.code).toBe(2);
  expect(broken.out).toContain('file src/a.ts');
  expect(broken.err).toContain('version must be 1');
  expect(broken.out).not.toContain('proof commit unavailable');
});

test('git decides whether a tracked path is clean, whatever its filters or type', () => {
  const { repo, env } = fixture();
  repo.git('config', 'core.autocrlf', 'true');
  symlinkSync('a.ts', join(repo.path, 'src/link'));
  repo.commit({ 'src/a.ts': 'export default 1;\n' });
  expect(repo.cli(['record', 'gate', '--outcome', 'green'], env).code).toBe(0);
  rmSync(join(repo.path, 'src/a.ts'));
  repo.git('checkout', '--', 'src/a.ts');
  expect(repo.git('status', '--porcelain')).toBe('');
  const result = repo.cli(['why', 'gate'], env);
  expect(result.code).toBe(0);
  expect(result.out).toContain(`file src/a.ts 100644 ${repo.git('rev-parse', 'HEAD:src/a.ts')}`);
  expect(result.out).toContain(`file src/link 120000 ${repo.git('rev-parse', 'HEAD:src/link')}`);
  expect(changes(result.out)).toEqual([]);
  expect(result.out).toContain('no inputs changed');
});

test('an import into a committed gitlink is unavailable, not an added file', () => {
  const { repo, env } = fixture([{ 'imports-of': 'src/a.ts' }]);
  const head = repo.git('rev-parse', 'HEAD');
  repo.git('update-index', '--add', '--cacheinfo', `160000,${head},src/sub`);
  repo.git('commit', '-qm', 'gitlink');
  repo.write('src/sub/a.ts', 'export default 3;');
  repo.write('src/a.ts', "import './sub/a';");
  const result = repo.cli(['why', 'gate'], env);
  expect(result.code).toBe(0);
  expect(result.out).not.toContain('src/sub/a.ts');
  expect(changes(result.out)).toEqual(['changed file src/a.ts']);
});

test('an unresolved input with nothing else changed claims only what was compared', () => {
  const { repo, env } = fixture([{ 'imports-of': 'src/a.ts' }]);
  repo.commit({ 'src/a.ts': "import './b';" });
  expect(repo.cli(['record', 'gate', '--outcome', 'green'], env).code).toBe(0);
  rmSync(join(repo.path, 'src/b.ts'));
  symlinkSync('a.ts', join(repo.path, 'src/b.ts'));
  const result = repo.cli(['why', 'gate'], env);
  expect(changes(result.out)).toEqual([]);
  expect(result.out).toContain('no comparable inputs changed');
});

test('working declarations compare semantic hashes and removed env names', () => {
  const { repo, env } = fixture();
  const doc = JSON.parse(repo.git('show', 'HEAD:proof.yaml'));
  const original = repo.cli(['why', 'gate'], env);
  doc.tasks.gate.inputs.reverse();
  doc.providers = { service: { start: 'touch executed' } };
  doc.tasks.gate.needs = ['service'];
  repo.write('proof.yaml', JSON.stringify(doc, null, 2));
  const cosmetic = repo.cli(['why', 'gate'], env);
  expect(cosmetic.code).toBe(0);
  expect(cosmetic.out.split('\n')[0]).toBe(repo.cli(['plan'], env).out.split('\n')[0]);
  expect(cosmetic.out.match(/^declaration .+$/m)?.[0]).toBe(
    original.out.match(/^declaration .+$/m)?.[0],
  );
  expect(cosmetic.out).not.toContain('declaration changed');
  doc.tasks.gate.run = 'false';
  doc.tasks.gate.env = [];
  repo.write('proof.yaml', JSON.stringify(doc));
  const changed = repo.cli(['why', 'gate'], env);
  expect(changed.code).toBe(0);
  expect(changed.out).toContain('declaration changed');
  expect(changes(changed.out)).toEqual([]);
});

test('dirty directories and nested repositories are unavailable, and deleted projections are removed', () => {
  const { repo, env } = fixture(['src/**', { path: 'config.json', json: ['selected'] }]);
  rmSync(join(repo.path, 'src/a.ts'));
  repo.write('src/a.ts/nested', 'directory entry');
  rmSync(join(repo.path, 'config.json'));
  repo.git('init', '-q', 'src/nested');
  repo.write('src/nested/a', 'nested repository');
  const result = repo.cli(['why', 'gate'], env);
  expect(result.code).toBe(0);
  expect(result.out).toContain("unavailable input 'src/a.ts'");
  expect(result.out).toContain("unavailable input 'src/nested'");
  expect(changes(result.out)).toEqual([
    'added file src/a.ts/nested',
    'removed member config.json selected',
  ]);
});

test('an invalid projection does not hide a known file deselection', () => {
  const { repo, env } = fixture(['src/**', { path: 'config.json', json: ['selected'] }]);
  const doc = JSON.parse(repo.git('show', 'HEAD:proof.yaml'));
  doc.tasks.gate.inputs = ['src/a.ts', { path: 'config.json', json: ['selected'] }];
  repo.write('proof.yaml', JSON.stringify(doc));
  repo.write('config.json', '{');
  const result = repo.cli(['why', 'gate'], env);
  expect(result.code).toBe(0);
  expect(result.out).toContain("input 'config.json': invalid JSON");
  expect(changes(result.out)).toEqual(['removed file src/b.ts']);
});

test('a working import cannot traverse an unsupported nested repository', () => {
  const { repo, env } = fixture([{ 'imports-of': 'src/a.ts' }]);
  repo.git('init', '-q', 'src/nested');
  repo.write('src/nested/a.ts', 'export default 3;');
  repo.write('src/a.ts', "import './nested/a';");
  const result = repo.cli(['why', 'gate'], env);
  expect(result.code).toBe(0);
  expect(result.out).toContain('unresolved import');
  expect(changes(result.out)).toEqual(['changed file src/a.ts']);
});

test('publication excludes env identities and why ignores historical env hashes', () => {
  for (const publisher of ['record', 'run']) {
    const { repo, env } = fixture(['src/**', { path: 'config.json', json: ['selected'] }]);
    const doc = JSON.parse(repo.git('show', 'HEAD:proof.yaml'));
    doc.tasks.gate.run = 'true';
    doc.tasks.gate.env.push('PROOF_WHY_EMPTY');
    repo.commit({ 'proof.yaml': JSON.stringify(doc) });
    const original = { ...env, PROOF_WHY_MODE: 'private-original', PROOF_WHY_EMPTY: '' };
    const published = repo.cli(
      publisher === 'record' ? ['record', 'gate', '--outcome', 'green'] : ['run'],
      original,
    );
    expect(published.code).toBe(0);
    const db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
    try {
      const row = db
        .query('SELECT env_hashes FROM proofs ORDER BY result_id DESC LIMIT 1')
        .get() as { env_hashes: string };
      expect(JSON.parse(row.env_hashes)).toEqual([]);
      db.query('UPDATE proofs SET env_hashes = ?').run(
        JSON.stringify([
          ['PROOF_WHY_MODE', 'historical'],
          ['stack.conf:FLAG', 'historical'],
        ]),
      );
    } finally {
      db.close();
    }
    expect(readFileSync(join(env.PROOF_STATE_DIR, 'proof.db')).includes('private-original')).toBe(
      false,
    );
    repo.commit({ 'config.json': '{"selected":2,"irrelevant":"changed"}' });
    const result = repo.cli(['why', 'gate'], { ...env, PROOF_WHY_MODE: 'private-new' });
    expect(result.code).toBe(0);
    expect(changes(result.out)).toEqual(['changed member config.json selected']);
    expect(result.out + result.err).not.toContain('private-original');
    expect(result.out + result.err).not.toContain('private-new');
  }
});

test('unavailable closure metadata cannot turn still-present workspace inputs into removals', () => {
  const { repo, env } = fixture([{ 'imports-of': 'src/a.ts' }]);
  repo.commit({
    'package.json': '{"workspaces":["packages/*"]}',
    'packages/tool/package.json': '{"name":"@tool","main":"index.ts"}',
    'packages/tool/index.ts': 'export default 3;',
    'src/a.ts': "import '@tool';",
  });
  expect(repo.cli(['record', 'gate', '--outcome', 'green'], env).code).toBe(0);
  rmSync(join(repo.path, 'package.json'));
  symlinkSync('config.json', join(repo.path, 'package.json'));
  const result = repo.cli(['why', 'gate'], env);
  expect(result.code).toBe(0);
  expect(result.out).toContain("unavailable input 'package.json'");
  expect(changes(result.out)).toEqual([]);
});

test('why prefers matching dimensions, including contested and offline proofs, before legacy fallback', () => {
  const { repo, env } = fixture();
  const doc = JSON.parse(repo.git('show', 'HEAD:proof.yaml'));
  doc.dimensions = { platform: 'printf "$PROOF_WHY_PLATFORM"' };
  doc.tasks.gate.dimensions = ['platform'];
  const a = repo.commit({ 'proof.yaml': JSON.stringify(doc) });
  const platform = (value: string, mode = 'new') => ({
    ...env,
    PROOF_WHY_PLATFORM: value,
    PROOF_WHY_MODE: mode,
  });
  for (const outcome of ['green', 'red'])
    expect(repo.cli(['record', 'gate', '--outcome', outcome], platform('ios', 'old')).code).toBe(0);
  const b = repo.commit({ 'src/a.ts': 'changed' });
  expect(repo.cli(['record', 'gate', '--outcome', 'green'], platform('android')).code).toBe(0);
  const matching = repo.cli(['why', 'gate'], platform('ios'));
  const missing = repo.cli(['why', 'gate'], platform('other'));
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  const offline = repo.cli(['why', 'gate'], {
    ...platform('ios'),
    PROOF_STORE: `postgres://proof@127.0.0.1:${port}/proof`,
  });
  using db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
  db.query(
    'UPDATE proofs SET env_hashes = NULL WHERE result_id IN (SELECT id FROM results WHERE "commit" = ?)',
  ).run(b);
  const legacy = repo.cli(['why', 'gate'], platform('ios'));
  db.exec('UPDATE proofs SET env_hashes = NULL');
  repo.write('src/a.ts', 'another change');
  const fallback = repo.cli(['why', 'gate'], platform('ios'));
  const results = [matching, missing, offline, legacy, fallback];
  expect(results.map((result) => result.code)).toEqual([0, 0, 0, 0, 0]);
  const notice =
    'no proof has these dimension values; dimensions differ; comparing with newest proof';
  expect({
    baselines: results.map((result) => result.out.match(/^comparison: (\S+) on /m)?.[1]),
    notices: results.map(
      (result) => result.out.split('\n').filter((line) => line === notice).length,
    ),
  }).toEqual({ baselines: [a, b, a, a, b], notices: [0, 1, 0, 0, 1] });
  expect(changes(matching.out)).toEqual(['changed file src/a.ts']);
  expect(changes(missing.out)).toEqual(['changed env dimension:platform']);
  expect(offline.err.trim().split('\n')).toEqual([
    expect.stringMatching(/^store unreachable \(.+\); using this machine's own proofs$/),
  ]);
  expect(fallback.out).toContain('env comparison unavailable');
  expect(changes(fallback.out)).toEqual(['changed file src/a.ts']);
});

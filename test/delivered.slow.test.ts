import { afterEach, expect, test } from 'bun:test';
import { readFileSync, rmSync, symlinkSync } from 'node:fs';
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
  expect(cli(['why', 'read'])).toContain('no inputs changed');
  expect(readFileSync(marker, 'utf8')).toBe('ab');
  cli(['run', '--fresh']);
  expect(readFileSync(marker, 'utf8')).toBe('Ab');
});

test('delivery uses committed bytes without blocking publication; selection keeps its bytes and key', () => {
  const { r, doc, marker, cli, plan } = fixture();
  const selectedMarker = join(r.path, '.git/selected');
  Object.assign(doc.tasks, {
    selected: { run: `cat assets/a > '${selectedMarker}'`, inputs: ['assets/a'] },
  });
  doc.tasks.read.run = `test ! -e assets/new && ${doc.tasks.read.run}`;
  r.commit({ 'proof.yaml': JSON.stringify({ ...doc, delivered: ['assets/**'] }) });
  r.write('assets/a', 'dirty');
  rmSync(join(r.path, 'assets/b'));
  r.write('assets/new', 'untracked');
  expect(cli(['run', '--tasks', 'read'])).toContain('green read; proof published');
  expect(readFileSync(marker, 'utf8')).toBe('ab');
  r.write('source', 'dirty source');
  cli(['run', '--fresh', '--tasks', 'read']);
  expect(readFileSync(marker, 'utf8')).toBe('ab');
  r.git('restore', 'source');
  const selected = cli(['run', '--tasks', 'selected']);
  expect(readFileSync(selectedMarker, 'utf8')).toBe('dirty');
  expect(selected).toContain('no proof published');
  r.git('restore', 'assets/a', 'assets/b');
  expect(plan().find((row) => row.task === 'selected')?.state).toBe('RUN');
  cli(['run', '--tasks', 'selected']);
  const before = plan();
  r.commit({ 'assets/a': 'A' });
  expect(plan().find((row) => row.task === 'read')?.state).toBe('PROVEN');
  expect(plan().find((row) => row.task === 'selected')?.key).not.toBe(
    before.find((row) => row.task === 'selected')?.key,
  );
});

test('delivery yields to links with component-aware exclusions', () => {
  const { r, doc, marker, cli } = fixture();
  const external = new Repo();
  repos.push(external);
  external.write('a', 'linked');
  doc.tasks.read.run = `cat assets/a assets-neighbor/a > '${marker}'`;
  Object.assign(doc.tasks.read, { links: ['assets'] });
  r.commit({
    'proof.yaml': JSON.stringify({ ...doc, delivered: ['assets*/**'] }),
    'assets-neighbor/a': 'neighbor',
  });
  rmSync(join(r.path, 'assets'), { recursive: true });
  symlinkSync(external.path, join(r.path, 'assets'));
  expect(cli(['run', '--tasks', 'read'])).toContain('green read; proof published');
  expect(readFileSync(marker, 'utf8')).toBe('linkedneighbor');
});

test('every reader validates delivery before filtering tasks', () => {
  const { r, doc, raw } = fixture();
  for (const pattern of ['absent/**', '!assets/a']) {
    r.commit({ 'proof.yaml': JSON.stringify({ ...doc, delivered: [pattern] }) });
    r.write('.git/cases.yaml', '[{name: bad, from: HEAD, to: HEAD, expect: []}]');
    for (const command of [
      'plan',
      'run --tasks read',
      'record read --outcome green',
      'why read',
      'status --ref HEAD',
      'lint',
      'doctor',
      'stats',
      'flakes',
      'invalidate --task read',
      'check .git/cases.yaml',
      'rekey',
    ]) {
      const result = raw(command.split(' '));
      expect(result.code, command + result.err + result.out).toBe(2);
      expect(result.err).toContain(
        `delivered: ${pattern.startsWith('!') ? 'negation' : 'unmatched'} '${pattern}'`,
      );
    }
  }
  for (const delivered of ['assets/**', [7]]) {
    r.commit({ 'proof.yaml': JSON.stringify({ ...doc, delivered }) });
    expect(raw(['plan']).err).toContain('delivered: expected');
  }
});

test('merged lists reach tasks, stay outside generators and provider mismatch, and why counts patterns', () => {
  const { r, doc, marker, cli, raw, plan } = fixture();
  const declaration = {
    ...doc,
    delivered: ['assets/**'],
    include: 'included.yaml',
    generate: {
      run: 'test ! -e assets/a && cp output "$PROOF_DECLARATIONS/tasks.yaml"',
      inputs: ['output'],
    },
    providers: { ready: { start: 'true' } },
    tasks: {
      read: {
        ...doc.tasks.read,
        run: `cat assets/a assets/b extra generated > '${marker}'`,
        needs: ['ready'],
      },
    },
  };
  r.commit({
    'proof.yaml': JSON.stringify(declaration),
    'included.yaml': 'delivered: [extra]',
    output: 'delivered: [generated, assets/**]',
    extra: 'e',
    generated: 'g',
  });
  const why = cli(['why', 'read']);
  expect(why.match(/^delivered pattern .+$/gm)).toEqual([
    'delivered pattern assets/**: 2 files',
    'delivered pattern extra: 1 files',
    'delivered pattern generated: 1 files',
  ]);
  r.write('assets/a', 'dirty');
  expect(cli(['run', '--staged'])).toContain('green read; proof published');
  expect(readFileSync(marker, 'utf8')).toBe('abeg');
  const before = plan()[0]?.key;
  r.commit({ 'assets/a': 'A', extra: 'E', generated: 'G' });
  expect(plan()[0]?.key).toBe(before);
  expect(plan()[0]?.state).toBe('PROVEN');
  for (const path of ['included.yaml', 'output']) {
    r.commit({ [path]: 'delivered: [absent/**]' });
    expect(raw(['plan']).err).toContain("delivered: unmatched 'absent/**'");
    r.commit({ [path]: path === 'output' ? 'delivered: [generated]' : 'delivered: [extra]' });
  }
});

import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

const repos: Repo[] = [];
const states: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  for (const state of states.splice(0)) rmSync(state, { recursive: true, force: true });
});
function fixture(project = 'example') {
  const repo = Repo.from(`plan:${project}`, (template) =>
    template.commit({
      'proof.yaml': JSON.stringify({
        version: 1,
        project,
        tasks: {
          lint: { run: 'exit 99', inputs: ['src/**'] },
          'docs-check': { run: 'exit 99', inputs: ['docs/guide/**'] },
        },
      }),
      'src/a.ts': 'a',
      'docs/guide/start.md': 'guide',
    }),
  );
  repos.push(repo);
  return repo;
}
function state() {
  const path = mkdtempSync(join(tmpdir(), 'proof-state-'));
  states.push(path);
  return { PROOF_STATE_DIR: path };
}

test('empty store plans every declared task with its reason', () => {
  const result = fixture().cli(['plan'], state());
  expect(result).toEqual({
    code: 0,
    err: '',
    out: 'RUN lint: no proof for key\nRUN docs-check: no proof for key\n',
  });
});

function record(repo: Repo, env: Record<string, string>, seconds = ['--seconds', '3']) {
  return repo.cli(['record', 'lint', '--outcome', 'green', ...seconds], env);
}

test('clean greens publish scoped proof reused by another clone', () => {
  const repo = fixture();
  const env = state();
  expect(record(repo, env).code).toBe(0);
  const clone = new Repo(repo);
  repos.push(clone);
  const result = clone.cli(['plan'], env);
  expect(result.code).toBe(0);
  expect(result.out).toContain(
    `PROVEN lint: proven at ${repo.git('rev-parse', 'HEAD')} on ${hostname()} `,
  );
  expect(result.out).toContain('RUN docs-check: no proof for key');
  const db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
  expect(db.query('SELECT outcome, seconds, dirty FROM results').all()).toEqual([
    {
      outcome: 'green',
      seconds: 3,
      dirty: 0,
    },
  ]);
  expect(db.query('SELECT result_id FROM proofs').all()).toEqual([
    {
      result_id: 1,
    },
  ]);
  db.close();
  expect(fixture('other').cli(['plan'], env).out).toContain('RUN lint: no proof for key');
});

test('store uses XDG state or HOME when no explicit directory is supplied', () => {
  const repo = fixture();
  for (const name of ['XDG_STATE_HOME', 'HOME']) {
    const base = state().PROOF_STATE_DIR;
    const env = { [name]: base };
    expect(record(repo, env).code).toBe(0);
    expect(repo.cli(['plan'], env).out).toContain('PROVEN lint');
    expect(
      Bun.file(join(base, name === 'HOME' ? '.local/state/proof/proof.db' : 'proof/proof.db')).size,
    ).toBeGreaterThan(0);
  }
});

test('plan gates selected dirty inputs but ignores unrelated files and tags', () => {
  const repo = fixture();
  const doc = JSON.parse(repo.git('show', 'HEAD:proof.yaml'));
  doc.tasks.lint.inputs = ['src/**', '!src/gen/**', 'src/gen/keep.ts'];
  repo.commit({
    'proof.yaml': JSON.stringify(doc),
    'src/c d.ts': 'space',
    'src/gen/x.ts': 'excluded',
    'src/gen/keep.ts': 'included',
    '.gitignore': 'src/gen/ignored.ts\n',
  });
  const env = state();
  expect(record(repo, env).code).toBe(0);
  repo.write('notes/todo.md', 'todo');
  expect(repo.cli(['plan'], env).out).toContain('PROVEN lint');
  repo.git('tag', 'release');
  expect(repo.cli(['plan'], env).out).toContain('PROVEN lint');
  repo.write('src/gen/x.ts', 'changed');
  repo.write('src/gen/ignored.ts', 'ignored and excluded');
  expect(repo.cli(['plan'], env).out).toContain('PROVEN lint');
  repo.git('restore', '.');
  for (const [path, stage, remove] of [
    ['src/a.ts', false, false],
    ['src/a.ts', true, false],
    ['src/b.ts', false, false],
    ['src/c d.ts', false, true],
    ['src/gen/keep.ts', false, false],
  ] as const) {
    if (remove) rmSync(join(repo.path, path));
    else repo.write(path, 'changed');
    if (stage) repo.git('add', path);
    const result = repo.cli(['plan'], env);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`RUN lint: undecidable: dirty input '${path}'`);
    expect(result.out).toContain('RUN docs-check: no proof for key');
    repo.git('reset', '--hard', 'HEAD');
    if (path === 'src/b.ts') rmSync(join(repo.path, path));
  }
});

test('restored historical bytes are undecidable until committed', () => {
  const repo = fixture();
  const env = state();
  expect(record(repo, env).code).toBe(0);
  repo.commit({ 'src/a.ts': 'b' });
  expect(repo.cli(['plan'], env).out).toContain('RUN lint: no proof for key');
  repo.write('src/a.ts', 'a');
  expect(repo.cli(['plan'], env).out).toContain("RUN lint: undecidable: dirty input 'src/a.ts'");
});

test('dirty records retain results without publishing even for unrelated dirtiness', () => {
  for (const path of ['src/a.ts', 'notes/todo.md']) {
    const repo = fixture();
    const env = state();
    repo.write(path, 'dirty');
    const result = record(repo, env, []);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`no proof published: dirty path '${path}'`);
    const db = new Database(join(env.PROOF_STATE_DIR, 'proof.db'));
    expect(db.query('SELECT outcome, seconds, dirty FROM results').all()).toEqual([
      { outcome: 'green', seconds: null, dirty: 1 },
    ]);
    expect(db.query('SELECT * FROM proofs').all()).toEqual([]);
    db.close();
    repo.git('restore', '.');
    if (path.startsWith('notes/')) rmSync(join(repo.path, path));
    expect(repo.cli(['plan'], env).out).toContain('RUN lint: no proof for key');
  }
});

test('JSON emits the same decisions as plain plan with exactly the public fields', () => {
  const repo = fixture();
  const env = state();
  expect(record(repo, env).code).toBe(0);
  const plain = repo.cli(['plan'], env);
  const json = repo.cli(['plan', '--json'], env);
  expect(json.code).toBe(0);
  expect(json.err).toBe('');
  const rows = JSON.parse(json.out);
  expect(rows.map((row: { task: string }) => row.task)).toEqual(['lint', 'docs-check']);
  for (const row of rows) {
    expect(Object.keys(row).sort()).toEqual(['key', 'reason', 'state', 'task']);
    expect(row.key).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(
    rows
      .map(
        (row: { task: string; state: string; reason: string }) =>
          `${row.state} ${row.task}: ${row.reason}\n`,
      )
      .join(''),
  ).toBe(plain.out);
});

test('dirty root or included declarations make every task undecidable', () => {
  const repo = fixture();
  const root = JSON.parse(repo.git('show', 'HEAD:proof.yaml'));
  root.include = 'proof.d/*.yaml';
  repo.commit({
    'proof.yaml': JSON.stringify(root),
    'proof.d/extra.yaml': JSON.stringify({
      tasks: {
        missing: { run: 'exit 99', inputs: ['absent/**'] },
      },
    }),
  });
  const env = state();
  expect(record(repo, env).code).toBe(0);
  expect(repo.cli(['plan'], env).out).toContain(
    "RUN missing: undecidable: unmatched input 'absent/**'",
  );
  for (const path of ['proof.yaml', 'proof.d/extra.yaml', 'proof.d/new.yaml']) {
    repo.write(
      path,
      path.endsWith('new.yaml') ? '{"tasks":{}}' : `${repo.git('show', `HEAD:${path}`)}\n`,
    );
    const result = repo.cli(['plan'], env);
    expect(result.code).toBe(0);
    expect(result.out.trim().split('\n')).toEqual(
      ['lint', 'docs-check', 'missing'].map(
        (id) => `RUN ${id}: undecidable: dirty declaration '${path}'`,
      ),
    );
    const json = repo.cli(['plan', '--json'], env);
    expect(json.code).toBe(0);
    for (const row of JSON.parse(json.out)) expect(row).not.toHaveProperty('key');
    repo.git('restore', '.');
    if (path.endsWith('new.yaml')) rmSync(join(repo.path, path));
  }
});

test('a submodule moved off its gitlink is dirty even when .gitmodules ignores it', () => {
  const repo = fixture();
  const sub = ['-C', 'src/sub', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];
  repo.git('init', '-q', 'src/sub');
  repo.git(...sub, 'commit', '-q', '--allow-empty', '-m', 'one');
  repo.commit({
    '.gitmodules': '[submodule "sub"]\n\tpath = src/sub\n\turl = ./sub\n\tignore = all\n',
  });
  const env = state();
  expect(record(repo, env).out).toContain('proof published');
  repo.git(...sub, 'commit', '-q', '--allow-empty', '-m', 'two');
  expect(repo.cli(['plan'], env).out).toContain("RUN lint: undecidable: dirty input 'src/sub'");
  expect(record(repo, env).out).toContain("no proof published: dirty path 'src/sub'");
});

test('empty-store JSON distinguishes input changes from unrelated dirt and tags', () => {
  const repo = fixture();
  const env = state();
  const rows = () => {
    const result = repo.cli(['plan', '--json'], env);
    expect(result.code).toBe(0);
    return JSON.parse(result.out);
  };
  const baseline = rows();
  expect(baseline[0].key).toMatch(/^[a-f0-9]{64}$/);
  repo.write('notes/todo.md', 'todo');
  expect(rows()).toEqual(baseline);
  repo.git('tag', 'release');
  expect(rows()).toEqual(baseline);
  repo.write('src/a.ts', 'changed');
  expect(rows()[0]).toEqual({
    task: 'lint',
    state: 'RUN',
    reason: "undecidable: dirty input 'src/a.ts'",
  });
  repo.commit({});
  expect(rows()[0].key).toMatch(/^[a-f0-9]{64}$/);
  expect(rows()[0].key).not.toBe(baseline[0].key);
});

test('shared globs keep dirty selection and negation task-local in either order', () => {
  for (const order of [
    ['all', 'filtered'],
    ['filtered', 'all'],
  ]) {
    const r = fixture();
    const tasks = Object.fromEntries(
      order.map((id) => [
        id,
        {
          run: 'true',
          inputs: id === 'all' ? ['src/**'] : ['src/**', '!src/gen/**'],
        },
      ]),
    );
    r.commit({
      'proof.yaml': JSON.stringify({ version: 1, project: 'shared', tasks }),
      'src/gen/x.ts': 'generated',
    });
    const env = state();
    for (const id of order) expect(r.cli(['record', id, '--outcome', 'green'], env).code).toBe(0);
    const rows = () => JSON.parse(r.cli(['plan', '--json'], env).out);
    const clean = rows();
    r.write('src/gen/new.ts', 'untracked');
    expect(rows()).toEqual(
      clean.map((row: { task: string }) =>
        row.task === 'all'
          ? { task: 'all', state: 'RUN', reason: "undecidable: dirty input 'src/gen/new.ts'" }
          : row,
      ),
    );
    rmSync(join(r.path, 'src/gen/new.ts'));
    r.write('src/a.ts', 'edited');
    expect(rows()).toEqual(
      order.map((task) => ({ task, state: 'RUN', reason: "undecidable: dirty input 'src/a.ts'" })),
    );
    r.git('restore', 'src/a.ts');
    expect(rows()).toEqual(clean);
    const from = r.git('rev-parse', 'HEAD');
    const to = r.commit({ 'src/gen/x.ts': 'changed' });
    const result = r.check([{ name: 'task-local exclusion', from, to, expect: ['all'] }]);
    expect(result.code, result.err + result.out).toBe(0);
  }
});

test('an ignored projection is missing and stays outside the sandbox', () => {
  const repo = fixture('prefilter-projection');
  repo.commit({
    '.gitignore': 'config.json\n',
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'prefilter-projection',
      tasks: {
        gate: { run: 'test ! -e config.json', inputs: [{ path: 'config.json', json: ['key'] }] },
      },
    }),
  });
  repo.write('config.json', '{"key":1}');
  const env = state();
  const [row] = JSON.parse(repo.cli(['plan', '--json'], env).out);
  expect(row.reason).toBe("undecidable: missing input 'config.json'");
  const why = repo.cli(['why', 'gate'], env);
  expect(why.out).toContain("missing input 'config.json'");
  expect(why.out).not.toContain('member config.json');
  const result = repo.cli(['run'], env);
  expect(result.code, result.err + result.out).toBe(0);
  expect(result.out).toContain("green gate; not recorded: missing input 'config.json'");
});

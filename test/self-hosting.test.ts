import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

const commit = ['lint', 'typecheck', 'test-fast'];
const all = [...commit, 'test-slow'];
function scenario(check: (r: Repo, run: (args: string[], executed: string[]) => string) => void) {
  return () => {
    const r = new Repo();
    const state = mkdtempSync(join(tmpdir(), 'proof-self-'));
    const log = join(state, 'executions');
    writeFileSync(log, '');
    try {
      const declaration = Bun.YAML.parse(
        readFileSync(new URL('../proof.yaml', import.meta.url), 'utf8'),
      ) as { tasks: Record<string, { run: string }> };
      for (const [id, task] of Object.entries(declaration.tasks))
        task.run = `echo ${id} >> '${log}'`;
      const files = `src/example.ts scripts/example.ts test/example.test.ts
      test/example.slow.test.ts test/support/repo.ts test/support/suite.ts
      test/support/postgres.ts package.json bun.lock tsconfig.json biome.json
      .gitignore README.md docs/store.md`.split(/\s+/);
      r.commit(Object.fromEntries(files.map((path) => [path, '{}\n'])));
      r.write('proof.yaml', JSON.stringify(declaration));
      r.git('add', '.');
      const executions = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
      const run = (args: string[], executed: string[]) => {
        const before = executions().length;
        const result = r.cli(args, { PROOF_STATE_DIR: state });
        expect(result.code, result.err + result.out).toBe(0);
        expect(executions().slice(before)).toEqual(executed);
        if (executed.length) expect(result.out).toContain('published');
        if (args[0] === 'run')
          for (const id of args.includes('commit') ? commit : all)
            expect(result.out).toContain(`${executed.includes(id) ? 'RUN' : 'PROVEN'} ${id}:`);
        return result.out;
      };
      check(r, run);
    } finally {
      r.close();
      rmSync(state, { recursive: true, force: true });
    }
  };
}

test(
  'commit proofs survive push and repeated push',
  scenario((r, run) => {
    run(['run', '--staged', '--set', 'commit'], commit);
    r.commit({});
    run(['run', '--set', 'push'], ['test-slow']);
    run(['run', '--set', 'push'], []);
  }),
  30_000,
);

test(
  'documentation selects only its consumers',
  scenario((r, run) => {
    run(['run', '--staged', '--set', 'push'], all);
    r.commit({});
    r.write('README.md', 'readme edit');
    r.git('add', '.');
    run(['run', '--staged', '--set', 'commit'], []);
    r.commit({});
    run(['run', '--set', 'push'], []);
    r.commit({ 'docs/store.md': 'store edit' });
    const rows = JSON.parse(run(['plan', '--set', 'push', '--json'], []));
    expect(
      rows
        .filter((row: { state: string }) => row.state === 'RUN')
        .map((row: { task: string }) => row.task),
    ).toEqual(['test-slow']);
    run(['run', '--staged', '--set', 'commit'], []);
    run(['run', '--set', 'push'], ['test-slow']);
  }),
  30_000,
);

test(
  'fast and slow test edits are linted, typed and owned',
  scenario((r, run) => {
    run(['run', '--staged', '--set', 'push'], all);
    r.commit({});
    for (const [path, expected] of [
      ['test/example.test.ts', commit],
      ['test/example.slow.test.ts', ['lint', 'typecheck']],
    ] as const) {
      r.write(path, 'test edit');
      r.git('add', '.');
      run(['lint'], []);
      run(['run', '--staged', '--set', 'commit'], [...expected]);
      r.commit({});
      run(['run', '--set', 'push'], path.includes('.slow.') ? ['test-slow'] : []);
    }
  }),
  30_000,
);

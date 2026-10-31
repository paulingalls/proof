import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { Repo } from '../test/support/repo';

export function measureClosures(phase: string, directory: string) {
  assert.ok(phase === 'before' || phase === 'after', 'expected before or after');
  const data = resolve(directory);
  mkdirSync(data, { recursive: true });
  const metadataPath = join(data, 'fixture.json');
  const repo = new Repo();
  let fixture: { path: string; commit: string; files: number; tasks: number };
  if (phase === 'before') {
    const ids = Array.from({ length: 250 }, (_, i) => `task${String(i).padStart(3, '0')}`);
    const tasks = Object.fromEntries(
      ids.map((id, i) => [
        id,
        {
          run: 'exit 99',
          inputs: [
            `${id}/src/**`,
            `${id}/test/**`,
            `${id}/fixtures/**`,
            `gates/${id}.sh`,
            'shared.json',
            '!task000/src/ignored/**',
            ...Array.from({ length: 50 }, (_, n) => ({
              'imports-of': `entries/e${(i + n) % 60}.ts`,
            })),
          ],
        },
      ]),
    );
    const declaration = JSON.stringify({ version: 1, project: 'scale', tasks });
    const files: Record<string, string> = {
      'proof.yaml': declaration,
      'shared.json': '{}',
      'CHANGELOG.md': 'baseline',
      '.gitignore': 'task000/src/ignored/*.txt\n',
      'task000/src/ignored/.keep': '',
      'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'] }),
      'tsconfig.json': '{}',
    };
    for (const id of ids) {
      for (const [dir, count] of [
        ['src', 30],
        ['test', 10],
        ['fixtures', 6],
      ] as const)
        for (let n = 0; n < count; n++) files[`${id}/${dir}/${n}.ts`] = 'export const value = 1;';
      files[`gates/${id}.sh`] = 'exit 99';
    }
    for (let n = 0; n < 60; n++)
      files[`entries/e${n}.ts`] = `import '../lib/l${2 * n}'; import '@scale/p${n % 5}';`;
    for (let n = 0; n < 120; n++)
      files[`lib/l${n}.ts`] = n === 119 ? 'export const end = 1;' : `export * from './l${n + 1}';`;
    for (let n = 0; n < 5; n++) {
      files[`packages/p${n}/package.json`] = JSON.stringify({
        name: `@scale/p${n}`,
        main: 'index.ts',
      });
      files[`packages/p${n}/index.ts`] = 'export const value = 1;';
    }
    const commit = repo.commit(files);
    fixture = { path: repo.path, commit, files: Object.keys(files).length, tasks: ids.length };
    writeFileSync(
      metadataPath,
      JSON.stringify({ ...fixture, bun: Bun.version, machine: cpus()[0]?.model }, null, 2),
    );
    writeFileSync(join(data, 'declaration.json'), declaration);
    for (let i = 0; i < 250; i += 17) {
      const result = repo.cli(['record', ids[i] as string, '--outcome', 'green'], {
        PROOF_STATE_DIR: join(data, 'state'),
      });
      assert.equal(result.code, 0, result.err);
    }
    repo.write('unrelated-untracked.txt', 'unrelated');
    for (let n = 0; n < 20; n++) repo.write(`task000/src/ignored/${n}.txt`, 'ignored');
  } else fixture = JSON.parse(readFileSync(metadataPath, 'utf8'));
  const profiles = join(data, phase);
  mkdirSync(profiles);
  const load = loadavg();
  const start = performance.now();
  const result = repo.cli(
    ['plan', '--json'],
    {
      PROOF_STATE_DIR: join(data, 'state'),
      BUN_OPTIONS: `--cpu-prof --cpu-prof-md --cpu-prof-dir=${profiles}`,
    },
    fixture.path,
  );
  const seconds = (performance.now() - start) / 1000;
  writeFileSync(join(data, `${phase}.json`), JSON.stringify({ seconds, load, ...result }, null, 2));
  console.log(JSON.stringify({ phase, seconds, load, code: result.code, fixture }));
  assert.equal(result.code, 0, result.err);
  const rows = JSON.parse(result.out);
  assert.equal(rows.length, 250);
  assert.equal(rows.filter((r: { state: string }) => r.state === 'PROVEN').length, 15);
  assert.equal(
    rows.filter(
      (r: { state: string; reason: string }) =>
        r.state === 'RUN' && r.reason === 'no proof for key',
    ).length,
    235,
  );
  if (phase === 'after') {
    const before = JSON.parse(readFileSync(join(data, 'before.json'), 'utf8'));
    assert.equal(result.err, before.err);
    assert.deepEqual(rows, JSON.parse(before.out));
    assert.ok(seconds < before.seconds, `plan ${seconds} >= before ${before.seconds}`);
    rmSync(fixture.path, { recursive: true, force: true });
    repo.close();
  }
}

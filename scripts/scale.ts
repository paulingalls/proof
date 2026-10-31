import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from '../test/support/repo';

if (process.argv[2] === 'closures') {
  const { measureClosures } = await import('./scale-closures');
  measureClosures(process.argv[3] ?? '', process.argv[4] ?? '');
} else {
  const repo = new Repo();
  const state = mkdtempSync(join(tmpdir(), 'proof-scale-state-'));
  try {
    const ids = Array.from({ length: 230 }, (_, i) => `task${String(i).padStart(3, '0')}`);
    const tasks = Object.fromEntries(
      ids.map((id) => [
        id,
        {
          run: 'exit 99',
          inputs: [
            `${id}/src/**`,
            `${id}/test/**`,
            `${id}/fixtures/**`,
            `gates/${id}.sh`,
            'shared.json',
          ],
        },
      ]),
    );
    const doc = { version: 1, project: 'scale', tasks };
    const files: Record<string, string> = {
      'proof.yaml': JSON.stringify(doc),
      'shared.json': '{}',
      'CHANGELOG.md': 'baseline',
    };
    for (const id of ids) {
      for (const [dir, count] of [
        ['src', 30],
        ['test', 10],
        ['fixtures', 6],
      ] as const) {
        for (let i = 0; i < count; i++) files[`${id}/${dir}/${i}.ts`] = `${id}/${dir}/${i}`;
      }
      files[`gates/${id}.sh`] = 'exit 99';
    }
    const baseline = repo.commit(files);
    const edits: [string, Record<string, string>, string[]][] = [
      ['changelog', { 'CHANGELOG.md': 'changed' }, []],
      ['gate', { 'gates/task000.sh': 'exit 98' }, ['task000']],
      ['source', { 'task000/src/0.ts': 'changed' }, ['task000']],
      ['test', { 'task001/test/0.ts': 'changed' }, ['task001']],
      ['fixture', { 'task002/fixtures/0.ts': 'changed' }, ['task002']],
      ['shared', { 'shared.json': '{"changed":true}' }, ids],
      [
        'command',
        {
          'proof.yaml': JSON.stringify({
            ...doc,
            tasks: { ...tasks, task003: { ...tasks.task003, run: 'exit 98' } },
          }),
        },
        ['task003'],
      ],
    ];
    const cases = edits.flatMap(([name, changes, expect]) => {
      repo.git('reset', '--hard', baseline);
      const descendant = repo.commit(changes);
      return [
        { name: `${name} forward`, from: baseline, to: descendant, expect },
        { name: `${name} reverse`, from: descendant, to: baseline, expect },
      ];
    });
    repo.git('reset', '--hard', baseline);
    const counts = {
      files: repo.git('ls-files', '-z').split('\0').filter(Boolean).length,
      tasks: Object.keys(tasks).length,
      cases: cases.length,
      refs: new Set(cases.flatMap((c) => [c.from, c.to])).size,
    };
    console.log(
      `${counts.files} files, ${counts.tasks} tasks, ${counts.cases} cases, ${counts.refs} distinct refs`,
    );
    assert.deepEqual(counts, { files: 10813, tasks: 230, cases: 14, refs: 8 });
    const path = join(state, 'cases.yaml');
    writeFileSync(path, JSON.stringify(cases));
    const env = { PROOF_STATE_DIR: state };
    const checkStart = performance.now();
    const check = repo.cli(['check', path], env);
    const checkSeconds = (performance.now() - checkStart) / 1000;
    const planStart = performance.now();
    const plan = repo.cli(['plan', '--json'], env);
    const planSeconds = (performance.now() - planStart) / 1000;
    console.log(`check ${checkSeconds.toFixed(3)} s; plan ${planSeconds.toFixed(3)} s`);
    assert.deepEqual(check, {
      code: 0,
      err: '',
      out: cases.map((c) => `PASS ${c.name}\n`).join(''),
    });
    assert.equal(plan.code, 0, plan.err);
    assert.equal(plan.err, '');
    assert.deepEqual(
      JSON.parse(plan.out),
      ids.map((task) => ({ task, state: 'RUN', reason: 'no proof for key' })),
    );
    assert.ok(checkSeconds < 4, `check must take under 4 s; took ${checkSeconds.toFixed(3)} s`);
    assert.ok(planSeconds < 1, `plan must take under 1 s; took ${planSeconds.toFixed(3)} s`);
  } finally {
    repo.close();
    rmSync(state, { recursive: true, force: true });
  }
}

import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, spawn, stop, task, until, wait } from './support/jobs';

test('default and explicit jobs=1 preserve the serial transcript', () => {
  const f = fixture({
    a: task('echo a-out; echo a-err >&2; exit 1'),
    b: task('echo b-out; echo b-err >&2'),
  });
  const expected = {
    code: 1,
    out: 'RUN a: no proof for key; trusted links: scratch\nRUN b: no proof for key; trusted links: scratch\na-out\na-err\nb-out\nb-err\nred a; log: <log>\ngreen b; proof published\n',
    err: '',
  };
  for (const args of [[], ['--jobs', '1']]) {
    const result = f.repo.cli(['run', ...args], { ...f.env, PROOF_STATE_DIR: f.directory() });
    const path = result.out.match(/red a; log: (.*)\n/)?.[1];
    expect(path).toMatch(/\/logs\/jobs\/a\/\d{8}T\d{9}Z-[a-f0-9]{8}-red\.log$/);
    expect(readFileSync(path as string, 'utf8')).toBe('a-out\na-err\n');
    expect({ ...result, out: result.out.replace(path as string, '<log>') }).toEqual(expected);
  }
}, 15000);

test('jobs requires one positive safe integer before the selector', () => {
  const f = fixture({ a: task('true') });
  for (const args of [
    ['--jobs', '0'],
    ['--jobs', 'x'],
    ['--jobs'],
    ['--jobs', '-1'],
    ['--jobs', '1.5'],
    ['--jobs', '9007199254740992'],
    ['--jobs', '1', '--jobs', '2'],
    ['--tasks', 'a', '--jobs', '2'],
  ]) {
    const result = f.run(...args);
    expect(result.code).toBe(2);
    expect(result.err).toContain(
      'usage: proof run [--fresh | --staged] [--jobs N] [--tasks <id> ... | --set <name>]',
    );
  }
  expect(f.run('--jobs', '2').code).toBe(0);
}, 15000);

test('two mutual-marker tasks need two jobs, without timing assertions', () => {
  for (const jobs of ['1', '2']) {
    const f = fixture(
      Object.fromEntries(
        ['a', 'b'].map((id) => [
          id,
          {
            ...task(`'${process.execPath}' barrier.ts ${id}`),
            inputs: ['input', 'barrier.ts'],
          },
        ]),
      ),
      {},
      {
        'barrier.ts': `import { existsSync, writeFileSync } from 'node:fs';
const id = process.argv[2];
writeFileSync('scratch/' + id, 'yes');
const deadline = Date.now() + 1500;
while (!existsSync('scratch/' + (id === 'a' ? 'b' : 'a'))) {
  if (Date.now() > deadline) { writeFileSync('scratch/failed', 'yes'); break; }
  await Bun.sleep(10);
}
process.exit(existsSync('scratch/failed') ? 1 : 0);`,
      },
    );
    const result = f.run('--jobs', jobs);
    expect(result.code, result.err + result.out).toBe(jobs === '2' ? 0 : 1);
    expect(f.rows().map((row) => row.outcome)).toEqual(
      jobs === '2' ? ['green', 'green'] : ['red', 'red'],
    );
  }
}, 15000);

test('dispatch is bounded and a free slot starts the next declared task', async () => {
  const f = fixture(
    Object.fromEntries(
      ['a', 'b', 'c'].map((id) => [id, task(`touch scratch/${id}; ${wait(`release-${id}`)}`)]),
    ),
  );
  const { child, output } = spawn(f, '--jobs', '2');
  try {
    await until(() => f.has('a') && f.has('b'));
    expect(f.has('c')).toBe(false);
    f.mark('release-a');
    await until(() => f.has('c'));
    expect(f.has('release-b')).toBe(false);
    f.mark('release-b');
    f.mark('release-c');
    expect(await child.exited).toBe(0);
    expect((await output)[1]).toBe('');
  } finally {
    for (const id of ['a', 'b', 'c']) f.mark(`release-${id}`);
    await stop(child);
  }
}, 15000);

test('one awaited provider stays ready for running and pending dependents', async () => {
  const f = fixture(
    {
      a: task(`test -f scratch/ready; touch scratch/a; ${wait('b')}; touch scratch/end-a`, [
        'stack',
      ]),
      b: task(`test -f scratch/ready; touch scratch/b; ${wait('a')}; touch scratch/end-b`, [
        'stack',
      ]),
      c: task('test -f scratch/ready; touch scratch/end-c', ['stack']),
    },
    {
      stack: {
        start: `echo start >> scratch/log; ${wait('release')}; touch scratch/ready`,
        stop: 'test -f scratch/end-a && test -f scratch/end-b && test -f scratch/end-c && echo stop >> scratch/log',
      },
    },
  );
  const { child, output } = spawn(f, '--jobs', '2');
  try {
    await until(() => f.has('log'));
    expect(f.has('a') || f.has('b')).toBe(false);
    f.mark('release');
    await until(() => child.exitCode !== null);
    const [out, err] = await output;
    expect(await child.exited, err + out).toBe(0);
    expect(f.read('log')).toBe('start\nstop\n');
    expect(f.rows().map((r) => r.outcome)).toEqual(['green', 'green', 'green']);
  } finally {
    f.mark('release');
    await stop(child);
  }
}, 15000);

test('failed shared startup records three incomplete dependents and lets unrelated work finish', async () => {
  const f = fixture(
    {
      a: task('touch scratch/should-not-run', ['stack']),
      b: task('touch scratch/should-not-run', ['stack']),
      c: task('touch scratch/should-not-run', ['stack']),
      other: task(`touch scratch/other; ${wait('failed')}; touch scratch/other-ended`),
    },
    {
      stack: {
        start: `echo start >> scratch/log; ${wait('release')}; touch scratch/failed; exit 1`,
        stop: 'echo stop >> scratch/log',
      },
    },
  );
  for (const id of ['a', 'b', 'c'])
    for (const outcome of ['green', 'red'])
      expect(f.repo.cli(['record', id, '--outcome', outcome], f.env).code).toBe(0);
  const proofs = f.rows('proofs');
  const contests = f.rows('contradictions');
  const { child, output } = spawn(f, '--jobs', '4');
  try {
    await until(() => f.has('other') && f.has('log'));
    f.mark('release');
    await until(() => child.exitCode !== null);
    const [out, err] = await output;
    expect(await child.exited, err + out).toBe(1);
    expect(err).toBe('');
    expect(
      f
        .rows()
        .slice(6)
        .sort((a, b) => a.task.localeCompare(b.task)),
    ).toMatchObject([
      { task: 'a', outcome: 'incomplete' },
      { task: 'b', outcome: 'incomplete' },
      { task: 'c', outcome: 'incomplete' },
      { task: 'other', outcome: 'green' },
    ]);
    expect(f.rows('proofs').filter((r) => r.task !== 'other')).toEqual(proofs);
    expect(f.rows('contradictions')).toEqual(contests);
    expect(f.has('should-not-run')).toBe(false);
    expect(f.read('log')).toBe('start\nstop\n');
  } finally {
    f.mark('release');
    f.mark('failed');
    await stop(child);
  }
}, 15000);

test('eight simultaneous greens retain every result and matching proof locally', () => {
  const ids = Array.from({ length: 8 }, (_, index) => `task${index}`);
  const f = fixture(
    Object.fromEntries(
      ids.map((id) => [
        id,
        task(
          `touch scratch/${id}; while test "$(find scratch/ -name 'task*' | wc -l)" -lt 8; do sleep 0.01; done`,
        ),
      ]),
    ),
  );
  const result = f.run('--jobs', '8');
  expect(result.code, result.err + result.out).toBe(0);
  expect(result.err).toBe('');
  const results = f.rows();
  const proofs = f.rows('proofs');
  expect(results).toHaveLength(8);
  expect(proofs).toHaveLength(8);
  for (const row of results) {
    expect(row.outcome).toBe('green');
    expect(proofs.find((p) => p.task === row.task)).toMatchObject({
      key: row.key,
      result_id: row.id,
    });
  }
  const plan = f.repo.cli(['plan', '--json'], f.env);
  expect(plan.code).toBe(0);
  expect(JSON.parse(plan.out).map((r: { state: string }) => r.state)).toEqual(
    ids.map(() => 'PROVEN'),
  );
}, 15000);

test('completed task blocks combine streams without interleaving or storing output', async () => {
  const f = fixture({
    a: task(
      `printf a-private-out; printf a-private-err >&2; touch scratch/a; ${wait('release-a')}; echo a-private-end`,
    ),
    b: task(
      `printf b-private-out; printf b-private-err >&2; touch scratch/b; ${wait('release-b')}; echo b-private-end`,
    ),
  });
  const { child, output } = spawn(f, '--jobs', '2');
  try {
    await until(() => f.has('a') && f.has('b'));
    f.mark('release-b');
    await until(() => f.rows().some((r) => r.task === 'b'));
    f.mark('release-a');
    expect(await child.exited).toBe(0);
    const [out, err] = await output;
    expect(err).toBe('');
    expect(out).toContain(
      '--- b\nb-private-outb-private-errb-private-end\n--- a\na-private-outa-private-erra-private-end\ngreen a; proof published\ngreen b; proof published\n',
    );
    for (const path of readdirSync(f.env.PROOF_STATE_DIR)) {
      if (!statSync(join(f.env.PROOF_STATE_DIR, path)).isFile()) continue;
      const bytes = readFileSync(join(f.env.PROOF_STATE_DIR, path)).toString();
      expect(bytes).not.toContain('a-private');
      expect(bytes).not.toContain('b-private');
    }
    expect(readdirSync(f.env.TMPDIR)).toEqual([]);
  } finally {
    f.mark('release-a');
    f.mark('release-b');
    await stop(child);
  }
}, 15000);

for (const committed of [false, true]) {
  test(`both provider waiters refresh after input edit, committed=${committed}`, async () => {
    const f = fixture(
      {
        a: task('test "$(cat input)" = changed', ['stack']),
        b: task('test "$(cat input)" = changed', ['stack']),
      },
      {
        stack: {
          start: `touch scratch/starting; ${wait('release')}; echo changed > input${committed ? '; git add input; git commit -qm provider' : ''}`,
        },
      },
    );
    for (const id of ['a', 'b'])
      for (const outcome of ['green', 'red'])
        expect(f.repo.cli(['record', id, '--outcome', outcome], f.env).code).toBe(0);
    const proofs = f.rows('proofs');
    const contests = f.rows('contradictions');
    const { child, output } = spawn(f, '--jobs', '2');
    try {
      await until(() => f.has('starting'));
      f.mark('release');
      expect(await child.exited).toBe(0);
      const [out, err] = await output;
      expect(err).toBe('');
      for (const id of ['a', 'b']) {
        expect(out).toContain(
          `RUN ${id}: ${committed ? 'no proof for key' : "undecidable: dirty input 'input'"}`,
        );
        expect(out).toContain(
          `green ${id}; ${committed ? 'no proof published: HEAD changed' : "no proof published: new dirty path 'input'"}`,
        );
      }
      expect(f.rows('proofs')).toEqual(proofs);
      expect(f.rows('contradictions')).toEqual(contests);
    } finally {
      f.mark('release');
      await stop(child);
    }
  }, 15000);
}

test('queued PROVEN task refreshes its decision before dispatch', async () => {
  const f = fixture(
    {
      a: task(`touch scratch/a; ${wait('release')}`),
      b: task(`touch scratch/b; ${wait('release-b')}`),
      c: { ...task('test "$(cat later)" = changed; touch scratch/c'), inputs: ['later'] },
    },
    {},
    { later: 'old' },
  );
  expect(f.repo.cli(['record', 'c', '--outcome', 'green'], f.env).code).toBe(0);
  const { child, output } = spawn(f, '--jobs', '2');
  try {
    await until(() => f.has('a') && f.has('b'));
    f.repo.write('later', 'changed');
    f.mark('release');
    await until(() => f.has('c'));
    f.mark('release-b');
    expect(await child.exited).toBe(0);
    const [out, err] = await output;
    expect(err).toBe('');
    expect(out).toContain('PROVEN c:');
    expect(out).toContain("RUN c: undecidable: dirty input 'later'");
    expect(out).toContain("green c; no proof published: dirty path 'later'");
  } finally {
    f.mark('release');
    f.mark('release-b');
    await stop(child);
  }
}, 15000);

test('staged startup remembers restored unstaged bytes for concurrent dependents', () => {
  const f = fixture(
    { a: task('true', ['held', 'stack']), b: task('false', ['gate', 'stack']) },
    {
      held: { start: `printf unstaged > input; touch scratch/held; ${wait('restored')}` },
      gate: { start: wait('held') },
      stack: {
        start: `${wait('held')}; cp input scratch/seen; git show :input > input; touch scratch/restored`,
      },
    },
  );
  for (const id of ['a', 'b'])
    for (const outcome of ['green', 'red'])
      expect(f.repo.cli(['record', id, '--outcome', outcome], f.env).code).toBe(0);
  const proofs = f.rows('proofs');
  const contests = f.rows('contradictions');
  const result = f.run('--staged', '--jobs', '2');
  expect(result.code, result.err + result.out).toBe(1);
  expect(f.read('seen')).toBe('unstaged');
  for (const id of ['a', 'b'])
    expect(result.out).toContain(`${id}; no proof published: provider can see unstaged 'input'`);
  expect(f.rows('proofs')).toEqual(proofs);
  expect(f.rows('contradictions')).toEqual(contests);
}, 15000);

test('a declaration edit cannot release a provider still used by a running task', async () => {
  const f = fixture(
    {
      a: task(`touch scratch/a; ${wait('release-a')}; test ! -f scratch/stopped`, ['stack']),
      b: task(`touch scratch/b; ${wait('release-b')}`),
      c: task('touch scratch/c'),
    },
    { stack: { start: 'true', stop: 'touch scratch/stopped' } },
  );
  const { child, output } = spawn(f, '--jobs', '2');
  try {
    await until(() => f.has('a') && f.has('b'));
    const yaml = JSON.parse(readFileSync(join(f.repo.path, 'proof.yaml'), 'utf8'));
    yaml.tasks.a.needs = [];
    f.repo.write('proof.yaml', JSON.stringify(yaml));
    f.mark('release-b');
    await until(() => f.has('c'));
    expect(f.has('stopped')).toBe(false);
    f.mark('release-a');
    const [out, err] = await output;
    expect(await child.exited, err + out).toBe(0);
    expect(f.has('stopped')).toBe(true);
  } finally {
    f.mark('release-a');
    f.mark('release-b');
    await stop(child);
  }
}, 15000);

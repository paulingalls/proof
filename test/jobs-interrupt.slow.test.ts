import { expect, test } from 'bun:test';
import { readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { alive, fixture, killGroup, spawn, stop, task, until, wait } from './support/jobs';

for (const ignore of [false, true]) {
  test(`SIGINT drains both groups and descendants; second signal required=${ignore}`, async () => {
    const f = fixture(
      Object.fromEntries(
        ['a', 'b'].map((id) => [
          id,
          {
            ...task(`echo $$ > scratch/leader-${id}; exec '${process.execPath}' worker.ts ${id}`),
            inputs: ['input', 'worker.ts'],
          },
        ]),
      ),
      {},
      {
        'worker.ts': `import { existsSync, writeFileSync } from 'node:fs';
const id = process.argv[2];
const child = Bun.spawn([process.execPath, '-e', \`import { writeFileSync } from 'node:fs';
process.on('SIGINT', () => { if (!${ignore}) process.exit(0); });
setInterval(() => {}, 1000); writeFileSync('scratch/child-ready-' + process.argv.at(-1), 'yes');\`, id]);
writeFileSync('scratch/child-' + id, String(child.pid));
process.on('SIGINT', () => {
  writeFileSync('scratch/ack-' + id, 'yes');
  if (!${ignore}) child.exited.then(() => process.exit(0));
});
setInterval(() => {}, 1000);
while (!existsSync('scratch/child-ready-' + id)) await Bun.sleep(10);
writeFileSync('scratch/ready-' + id, 'yes');`,
      },
    );
    const { child, output } = spawn(f, '--jobs', '2');
    const pids: number[] = [];
    try {
      await until(() => f.has('ready-a') && f.has('ready-b'));
      for (const id of ['a', 'b'])
        pids.push(Number(f.read(`leader-${id}`)), Number(f.read(`child-${id}`)));
      process.kill(child.pid, 'SIGINT');
      await until(() => f.has('ack-a') && f.has('ack-b'));
      if (ignore) {
        expect(child.exitCode).toBe(null);
        process.kill(child.pid, 'SIGINT');
      }
      await until(() => child.exitCode !== null);
      expect(await child.exited).toBe(130);
      const [out, err] = await output;
      expect(err).toBe('');
      for (const id of ['a', 'b']) expect(out).toContain(`incomplete ${id}`);
      expect(f.rows().sort((a, b) => a.task.localeCompare(b.task))).toMatchObject([
        { task: 'a', outcome: 'incomplete' },
        { task: 'b', outcome: 'incomplete' },
      ]);
      expect(f.rows('proofs')).toEqual([]);
      expect(f.rows('contradictions')).toEqual([]);
      await until(() => pids.every((pid) => !alive(pid)));
      expect(readdirSync(f.env.TMPDIR)).toEqual([]);
    } finally {
      for (const id of ['a', 'b'])
        if (f.has(`leader-${id}`)) killGroup(Number(f.read(`leader-${id}`)));
      await stop(child);
    }
  }, 20000);
}

for (const fresh of [false, true]) {
  test(`materialization failure drains siblings or finishes fresh tasks; fresh=${fresh}`, async () => {
    const f = fixture(
      {
        a: task(`echo $$ > scratch/leader-a; exec '${process.execPath}' active.ts`),
        broken: { ...task('true', ['stack']), inputs: ['link'] },
        later: task('touch scratch/later'),
      },
      {
        stack: {
          start: `${wait('ready')}; touch scratch/started`,
          stop: `${fresh ? 'true' : '! kill -0 "$(cat scratch/leader-a)" 2>/dev/null'} && touch scratch/stopped`,
        },
      },
      {
        'active.ts': `import { existsSync, writeFileSync } from 'node:fs';
process.on('SIGINT', () => {});
writeFileSync('scratch/ready', 'yes');
while (!existsSync('scratch/release')) await Bun.sleep(10);
writeFileSync('scratch/ended', 'yes');`,
      },
    );
    const yaml = JSON.parse(await Bun.file(join(f.repo.path, 'proof.yaml')).text());
    yaml.tasks.a.inputs.push('active.ts');
    symlinkSync('input', join(f.repo.path, 'link'));
    f.repo.commit({ 'proof.yaml': JSON.stringify(yaml) });
    const { child, output } = spawn(f, ...(fresh ? ['--fresh'] : []), '--jobs', '2');
    let pid: number | undefined;
    try {
      await until(() => f.has('ready'));
      pid = Number(f.read('leader-a'));
      if (fresh) {
        await until(() => f.rows().some((r) => r.task === 'broken'));
        f.mark('release');
      }
      await until(() => child.exitCode !== null);
      const [out, err] = await output;
      expect(await child.exited, err + out).toBe(fresh ? 1 : 2);
      expect(f.has('stopped')).toBe(true);
      expect(f.has('later')).toBe(fresh);
      expect(f.rows().sort((a, b) => a.task.localeCompare(b.task))).toMatchObject(
        fresh
          ? [
              { task: 'a', outcome: 'green' },
              { task: 'broken', outcome: 'incomplete' },
              { task: 'later', outcome: 'green' },
            ]
          : [{ task: 'a', outcome: 'incomplete' }],
      );
      expect(fresh ? out : err).toContain("selected path 'link': symlink");
      await until(() => !alive(pid as number));
      expect(readdirSync(f.env.TMPDIR)).toEqual([]);
    } finally {
      f.mark('release');
      if (pid) killGroup(pid);
      await stop(child);
    }
  }, 20000);
}

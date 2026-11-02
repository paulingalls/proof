import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

test('plan inspects each normalized complete link set once and preserves decisions', () => {
  const repo = new Repo();
  const state = mkdtempSync(join(tmpdir(), 'proof-plan-links-'));
  try {
    const task = (links: string[], sets: string[] = []) => ({
      run: 'true',
      inputs: ['input'],
      links,
      sets,
    });
    repo.commit({
      input: 'selected',
      '.gitignore': 'installed/\n',
      'proof.yaml': JSON.stringify({
        version: 1,
        project: 'plan-links',
        tasks: {
          combined: task(['installed', 'node_modules'], ['combined']),
          reordered: task(['node_modules', 'installed', 'node_modules']),
          repeated: task(['installed', 'node_modules']),
          subset: task(['node_modules'], ['subset']),
          subsetAgain: task(['node_modules']),
        },
      }),
    });
    repo.write('installed/package/index.js', 'installed');
    symlinkSync('../installed/package', join(repo.path, 'node_modules/shared'));
    const roots = ['installed', 'node_modules'].map((path) => realpathSync(join(repo.path, path)));
    const preload = join(state, 'count.cjs');
    writeFileSync(
      preload,
      `
      const fs = require('node:fs');
      const counts = Object.fromEntries(${JSON.stringify(roots)}.map(root => [root, 0]));
      const read = fs.readdirSync;
      fs.readdirSync = function(path, ...args) {
        if (Object.hasOwn(counts, path)) counts[path]++;
        return read.call(this, path, ...args);
      };
      process.on('exit', () => console.error('LINK_SCANS=' + JSON.stringify(counts)));
    `,
    );
    const env = { PROOF_STATE_DIR: state, BUN_OPTIONS: `--preload=${preload}` };
    const plan = repo.cli(['plan', '--json'], env);
    expect(plan.code).toBe(0);
    const rows = JSON.parse(plan.out);
    expect(rows.map((row: { task: string }) => row.task)).toEqual([
      'combined',
      'reordered',
      'repeated',
      'subset',
      'subsetAgain',
    ]);
    for (const [index, name] of [
      [0, 'combined'],
      [3, 'subset'],
    ] as const) {
      const single = repo.cli(['plan', '--set', name, '--json'], env);
      expect(single.code).toBe(0);
      expect(JSON.parse(single.out)).toEqual([rows[index]]);
    }
    for (const row of rows.slice(0, 3)) {
      expect(row.state).toBe('RUN');
      expect(row.reason).toBe('no proof for key; trusted links: installed, node_modules');
    }
    const reason = `untrusted links; link escape 'node_modules/shared' -> '${roots[0]}/package'`;
    for (const row of rows.slice(3)) {
      expect(row.state).toBe('RUN');
      expect(row.reason).toBe(reason);
    }
    const why = repo.cli(['why', 'subset'], env);
    expect(why.code).toBe(0);
    expect(why.out.split('\n')[0]).toBe(`RUN subset: ${reason}`);
    const counts = JSON.parse(plan.err.split('LINK_SCANS=')[1] as string);
    expect(counts).toEqual({ [roots[0] as string]: 1, [roots[1] as string]: 2 });
  } finally {
    repo.close();
    rmSync(state, { recursive: true, force: true });
  }
});

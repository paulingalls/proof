import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

function cleanup(failures: number) {
  const repo = new Repo();
  const control = mkdtempSync(join(tmpdir(), 'proof-cleanup-'));
  const attempts = join(control, 'attempts');
  const preload = join(control, 'preload.ts');
  writeFileSync(
    preload,
    `import { mock } from 'bun:test';
import * as fs from 'node:fs';
const remove = fs.rmSync;
let count = 0;
mock.module('node:fs', () => ({ ...fs, rmSync(path, options) {
  if (fs.existsSync(path + '/fail-cleanup')) {
    fs.appendFileSync(process.env.CLEANUP_ATTEMPTS, path + '\\n');
    if (++count <= Number(process.env.CLEANUP_FAILURES)) throw new Error('ENOTEMPTY');
  }
  remove(path, options);
} }));`,
  );
  const until = (body: string) =>
    `for i in $(seq 1000); do [ -e '${attempts}' ] && exit 0; ${body} sleep 0.01; done; exit 1`;
  repo.commit({
    lock: 'locked',
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'cleanup',
      tasks: Object.fromEntries(
        Object.entries({
          target: `touch fail-cleanup; (${until('touch scratch;')}) >/dev/null 2>&1 &`,
          sibling: until(''),
          queued: 'true',
        }).map(([id, run]) => [id, { run, inputs: ['lock'] }]),
      ),
    }),
  });
  try {
    const result = repo.cli(['run', '--jobs', '2'], {
      PROOF_STATE_DIR: control,
      TMPDIR: control,
      BUN_OPTIONS: `--preload=${preload}`,
      CLEANUP_ATTEMPTS: attempts,
      CLEANUP_FAILURES: String(failures),
    });
    const path = readFileSync(attempts, 'utf8').split('\n')[0] as string;
    using db = new Database(join(control, 'proof.db'));
    expect(result.code).toBe(0);
    expect(db.query('SELECT task, outcome FROM results ORDER BY task').all()).toEqual(
      ['queued', 'sibling', 'target'].map((task) => ({ task, outcome: 'green' })),
    );
    for (const task of ['target', 'sibling', 'queued'])
      expect(result.out).toContain(`green ${task}; proof published`);
    if (failures > 1) {
      expect(result.out.split('\n').filter((line) => line.startsWith('warning:'))).toEqual([
        `warning: sandbox cleanup failed for target; left behind: ${path}; Error: ENOTEMPTY`,
      ]);
      expect(existsSync(path)).toBe(true);
    } else {
      expect(readdirSync(control).filter((name) => name.startsWith('proof-sandbox-'))).toEqual([]);
      expect(result.out + result.err).not.toContain('sandbox cleanup');
    }
  } finally {
    repo.close();
    rmSync(control, { recursive: true, force: true });
  }
}

test('exhausted sandbox cleanup preserves sibling and queued outcomes', () => cleanup(99));
test('sandbox cleanup succeeds on retry without a diagnostic', () => cleanup(1));

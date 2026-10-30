import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';
import { suiteCases, suiteFixture } from './support/suite';

const repos: Repo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
});

test('requirement suite selects exact RUN sets for cases 4, 9, 10 and 12', () => {
  const r = new Repo();
  repos.push(r);
  const baseline = suiteFixture(r);
  const cases = suiteCases(r, baseline);
  const result = r.check(cases);
  expect(result.code).toBe(0);
  expect(result.err).toBe('');
  expect(result.out).toBe('PASS baseline\nPASS case 4\nPASS case 9\nPASS case 10\nPASS case 12\n');
});

test('case 6 follows each journey closure and preserves unrelated proofs', () => {
  const r = Repo.from('maestro-suite', (r) => {
    suiteFixture(r);
  });
  repos.push(r);
  const env = { PROOF_STATE_DIR: mkdtempSync(join(tmpdir(), 'proof-suite-')) };
  const cases = [];
  let from = r.git('rev-parse', 'HEAD');
  try {
    for (const path of [
      'flows/alpha.yaml',
      'flows/nested/login.yaml',
      'assets/login.js',
      'assets/photo.bin',
    ]) {
      for (const id of ['native:alpha', 'native:beta']) {
        const record = r.cli(['record', id, '--outcome', 'green'], env);
        expect(record.code, record.err).toBe(0);
        expect(record.out).toContain('published');
      }
      const rows = () => {
        const result = r.cli(['plan', '--json'], env);
        expect(result.code, result.err).toBe(0);
        return JSON.parse(result.out).filter((row: { task: string }) =>
          ['native:alpha', 'native:beta'].includes(row.task),
        );
      };
      expect(rows().map((row: { state: string }) => row.state)).toEqual(['PROVEN', 'PROVEN']);
      const target = `apps/mobile/${path}`;
      if (path.endsWith('.bin')) writeFileSync(join(r.path, target), Buffer.from([0, 254, 2]));
      else
        r.write(
          target,
          `${r.git('show', `HEAD:${target}`)}\n# changed\n`.replace(
            '# changed',
            path.endsWith('.js') ? '// changed' : '# changed',
          ),
        );
      const to = r.commit({});
      expect(rows().map((row: { state: string }) => row.state)).toEqual(['RUN', 'PROVEN']);
      cases.push({ name: path, from, to, expect: ['native:alpha'] });
      from = to;
    }
    r.write('apps/mobile/flows/alpha.yaml', 'invalid: [');
    const result = r.check(cases);
    expect(result.code, result.err + result.out).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toBe(cases.map((row) => `PASS ${row.name}\n`).join(''));
  } finally {
    rmSync(env.PROOF_STATE_DIR, { recursive: true, force: true });
  }
  // About 25 CLI processes: Bun's 5 s default fails it when other clones load this shared Mac.
}, 30_000);

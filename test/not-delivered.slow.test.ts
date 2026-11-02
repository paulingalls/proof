import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './support/jobs';

const summary = (out: string, id: string) =>
  out.split('\n').find((line) => line.startsWith(`red ${id};`)) ?? '';
const diagnostic = (path: string) => `printf '%s\\n' 'cat: ${path}: No such file or directory'`;

test('red summaries name omitted tracked paths, keeping delivery separate from keys', () => {
  const forms = {
    relative: 'cat ./omitted',
    absolute: 'cp "$(pwd)/omitted" copy',
    spaces: 'cat "with spaces"',
    python: `printf "%s\\n" "[Errno 2] No such file or directory: 'omitted'"; false`,
    bun: `printf "%s\\n" "ENOENT: no such file or directory, open 'omitted'"; false`,
    apostrophe: `printf "%s\\n" "can't open file 'omitted': [Errno 2] No such file or directory"; false`,
    go: `printf '%s\\n' 'open omitted: no such file or directory'; false`,
    shell: `printf '%s\\n' 'script: line 4: omitted: No such file or directory'; false`,
    exclusions: `${['absent', 'input', 'config.json', 'shared', '/outside/omitted', '../omitted', 'collision', 'directory'].map(diagnostic).join('; ')}; printf '%s\\n' 'Script not found: omitted'; cat omitted`,
  };
  const inputs = ['input', 'shared', { path: 'config.json', json: ['name'] }];
  const f = fixture(
    {
      ...Object.fromEntries(Object.entries(forms).map(([id, run]) => [id, { run, inputs }])),
      green: { run: diagnostic('omitted'), inputs },
    },
    {},
    {
      omitted: 'yes',
      'with spaces': 'yes',
      'config.json': '{"name":"x"}',
      shared: 'yes',
      'nested/collision': 'yes',
      'directory/file': 'yes',
    },
  );
  const declaration = JSON.parse(f.repo.git('show', 'HEAD:proof.yaml'));
  declaration['super-only'] = ['shared'];
  f.repo.commit({ 'proof.yaml': JSON.stringify(declaration) });
  const result = f.run();
  expect(result.code, result.err).toBe(1);
  expect(f.rows().map((row) => row.outcome)).toEqual([
    ...Object.keys(forms).map(() => 'red'),
    'green',
  ]);
  for (const id of Object.keys(forms)) {
    const line = summary(result.out, id);
    expect(line).toContain(
      `; not delivered: ${id === 'spaces' ? 'with spaces' : 'omitted'}; log: `,
    );
    const bytes = readFileSync(line.split('; log: ')[1] as string, 'utf8');
    expect(bytes).toMatch(/no such file or directory/i);
    expect(result.out).toContain(bytes.trim());
  }
  expect(result.out.split('\n').find((line) => line.startsWith('green green;'))).not.toContain(
    'not delivered',
  );
});

test('a pruned retained log leaves the red unchanged', () => {
  const f = fixture(
    {
      pruned: { run: 'cat omitted', inputs: ['input'] },
      readable: { run: 'cat omitted', inputs: ['input'] },
    },
    {},
    { omitted: 'yes' },
  );
  const directory = join(f.env.PROOF_STATE_DIR, 'logs/jobs/tasks/pruned');
  mkdirSync(directory, { recursive: true });
  for (let n = 90; n < 100; n++) writeFileSync(join(directory, `${n}.log`), '');
  const result = f.run();
  expect(result.code, result.err).toBe(1);
  expect(f.rows().map((row) => row.outcome)).toEqual(['red', 'red']);
  const line = summary(result.out, 'pruned');
  expect(line).toContain('; log: ');
  expect(line).not.toContain('not delivered');
  expect(existsSync(line.split('; log: ')[1] as string)).toBe(false);
  expect(summary(result.out, 'readable')).toContain('; not delivered: omitted; log: ');
});

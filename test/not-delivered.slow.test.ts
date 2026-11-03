import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './support/jobs';

const summary = (out: string, id: string) =>
  out.split('\n').find((line) => line.startsWith(`red ${id};`)) ?? '';
const diagnostic = (path: string) => `printf '%s\\n' 'cat: ${path}: No such file or directory'`;

test('red summaries name omitted tracked paths, keeping delivery separate from keys', () => {
  const forms = {
    many: `${['omitted', 'input', 'omitted', 'absent', 'with spaces', 'nested/collision', 'directory/file', 'extra'].map(diagnostic).join('; ')}; false`,
    relative: 'cat ./omitted',
    absolute: 'cp "$(pwd)/omitted" copy',
    spaces: 'cat "with spaces"',
    python: `printf "%s\\n" "[Errno 2] No such file or directory: 'omitted'"; false`,
    bun: `printf "%s\\n" "ENOENT: no such file or directory, open 'omitted'"; false`,
    apostrophe: `printf "%s\\n" "can't open file 'omitted': [Errno 2] No such file or directory"; false`,
    go: `printf '%s\\n' 'open omitted: no such file or directory'; false`,
    shell: `printf '%s\\n' 'script: line 4: omitted: No such file or directory'; false`,
    exclusions: `rm input config.json shared; ${['absent', 'input', 'config.json', 'shared', '/outside/omitted', '../omitted', 'collision', 'directory'].map(diagnostic).join('; ')}; printf '%s\\n' 'Script not found: omitted'; cat omitted`,
  };
  const inputs = ['input', 'shared', { path: 'config.json', json: ['name'] }];
  const f = fixture(
    {
      ...Object.fromEntries(Object.entries(forms).map(([id, run]) => [id, { run, inputs }])),
      green: { run: diagnostic('omitted'), inputs },
    },
    {},
    {
      extra: 'yes',
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
      `; not delivered: ${id === 'many' ? 'omitted, with spaces, nested/collision (+2 more)' : id === 'spaces' ? 'with spaces' : 'omitted'}; log: `,
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

test('workspace module errors name omitted export targets on the first red', () => {
  const leaf = 'packages/db/__tests__/fixture.ts';
  const error = (message: string) => `printf '%s\\n' '${message}'; false`;
  const module = 'Cannot find module "@fixture/db/testing/fixture"';
  const forms = {
    actual: {
      run: `'${process.execPath}' --no-install entry.ts`,
      inputs: [{ 'imports-of': 'entry.ts' }, '!**/__tests__/**'],
    },
    root: { run: error('Cannot find package "@fixture/db"'), inputs: ['input'] },
    subpath: {
      run: `echo "Cannot find module '@fixture/db/testing/fixture'"; false`,
      inputs: ['input'],
    },
    conditional: {
      run: error('Cannot find module "@fixture/db/conditional"'),
      inputs: ['input', 'packages/db/import.ts'],
    },
    selected: { run: error(module), inputs: ['input', leaf] },
    unknown: { run: error('Cannot find module "@fixture/db/unknown"'), inputs: ['input'] },
    missing: { run: error('Cannot find module "@fixture/db/missing"'), inputs: ['input'] },
    thirdparty: { run: error('Cannot find package "third-party"'), inputs: ['input'] },
    alias: { run: error('Cannot find module "@alias/fixture"'), inputs: ['input'] },
  };
  const f = fixture(
    forms,
    {},
    {
      'package.json': JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] }),
      'packages/db/package.json': JSON.stringify({
        name: '@fixture/db',
        exports: {
          '.': './__tests__/fixture.ts',
          './testing/fixture': { import: './__tests__/fixture.ts' },
          './conditional': { import: './import.ts', require: './require.ts' },
          './missing': './missing.ts',
        },
      }),
      [leaf]: 'export const value = 1;',
      'packages/db/import.ts': 'export {};',
      'packages/db/require.ts': 'module.exports = {};',
      'entry.ts': "import { value } from '@fixture/db/testing/fixture'; console.log(value);",
      'tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { '@alias/*': ['packages/db/__tests__/*'] } },
      }),
    },
  );
  const result = f.run();
  expect(result.code, result.err).toBe(1);
  expect(f.rows().map((row) => row.outcome)).toEqual(Object.keys(forms).map(() => 'red'));
  for (const id of ['actual', 'root', 'subpath', 'conditional', 'alias']) {
    const line = summary(result.out, id);
    expect(line).toContain(
      `; not delivered: ${id === 'conditional' ? 'packages/db/require.ts' : leaf}; log: `,
    );
    const bytes = readFileSync(line.split('; log: ')[1] as string, 'utf8');
    expect(bytes).toMatch(/Cannot find (module|package)/);
    expect(result.out).toContain(bytes.trim());
  }
  for (const id of ['selected', 'unknown', 'missing', 'thirdparty']) {
    expect(summary(result.out, id)).not.toContain('not delivered');
  }
});

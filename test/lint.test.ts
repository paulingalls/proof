import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Repo } from './support/repo';

const repos: Repo[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.close();
});
const declaration = `version: 1
project: fixture
tasks:
  verify:
    run: exit 99
    inputs: [src/**]
`;

test('coverage and exemptions do not contribute to task keys', () => {
  const r = new Repo();
  repos.push(r);
  const a = r.commit({ 'proof.yaml': declaration, 'src/a.ts': 'a' });
  const coverage = `${declaration}coverage: [scripts/*.sh]\n`;
  const b = r.commit({ 'proof.yaml': coverage });
  const c = r.commit({ 'proof.yaml': `${coverage}exempt: {scripts/a.sh: manual}\n` });
  const d = r.commit({ 'proof.yaml': `${coverage}exempt: {scripts/a.sh: external}\n` });
  const e = r.commit({ 'src/a.ts': 'changed' });
  const result = r.check([
    { name: 'coverage', from: a, to: b, expect: [] },
    { name: 'exemption', from: b, to: c, expect: [] },
    { name: 'reason', from: c, to: d, expect: [] },
    { name: 'source', from: d, to: e, expect: ['verify'] },
  ]);
  expect(result).toEqual({
    code: 0,
    err: '',
    out: 'PASS coverage\nPASS exemption\nPASS reason\nPASS source\n',
  });
});

test('lint checks every positive input in the index and ignores unstaged edits', () => {
  const r = new Repo();
  repos.push(r);
  r.commit({
    'proof.yaml': declaration.replace(
      '[src/**]',
      "[scripts/gone/**, {path: config/app.json, json: [name]}, '!absent/**', src/**]",
    ),
    'src/a.ts': 'a',
  });
  const missing = {
    code: 1,
    err: '',
    out: "task 'verify': unmatched input 'scripts/gone/**'\ntask 'verify': missing input 'config/app.json'\n",
  };
  expect(r.cli(['lint'])).toEqual(missing);
  r.write('scripts/gone/a.sh', 'exit 0');
  r.write('config/app.json', 'not parsed by lint');
  expect(r.cli(['lint'])).toEqual(missing);
  r.git('add', 'scripts', 'config');
  r.write('proof.yaml', ': invalid yaml [');
  expect(r.cli(['lint'])).toEqual({ code: 0, out: '', err: '' });
  r.git('commit', '-qm', 'repair inputs');
  r.git('rm', 'scripts/gone/a.sh');
  expect(r.cli(['lint'])).toEqual({
    code: 1,
    err: '',
    out: "task 'verify': unmatched input 'scripts/gone/**'\n",
  });
  expect(r.cli(['lint', 'extra'])).toEqual({
    code: 2,
    out: '',
    err: 'proof: usage: proof lint\n',
  });
});

test('lint rejects an empty exemption reason as a declaration error', () => {
  const r = new Repo();
  repos.push(r);
  r.commit({
    'proof.yaml': `${declaration}exempt: {scripts/a.sh: ''}\n`,
    'src/a.ts': 'a',
  });
  const result = r.cli(['lint']);
  expect(result.code).toBe(2);
  expect(result.err).toContain("exempt 'scripts/a.sh' reason: expected a nonempty string");
});

test('covered paths require ordered ownership or an exemption', () => {
  const r = new Repo();
  repos.push(r);
  const tasks = declaration.replace(
    '[src/**]',
    "['scripts/**', '!scripts/verify-*.sh', scripts/verify-z.sh]",
  );
  const coverage = 'coverage: [scripts/verify-*.sh]\n';
  r.commit({
    'proof.yaml': `${tasks}coverage: [scripts/verify-*.sh, tools/*.sh]\n`,
    'scripts/lib.sh': '',
    'scripts/verify-x.sh': '',
    'scripts/verify-y.sh': '',
    'scripts/verify-z.sh': '',
    'notes.md': '',
  });
  expect(r.cli(['lint'])).toEqual({
    code: 1,
    err: '',
    out: "coverage: unmatched pattern 'tools/*.sh'\nunowned 'scripts/verify-x.sh'\nunowned 'scripts/verify-y.sh'\n",
  });
  r.write(
    'proof.yaml',
    `${tasks.replace('scripts/verify-z.sh]', 'scripts/verify-z.sh, scripts/verify-x.sh, scripts/verify-y.sh]')}${coverage}`,
  );
  r.git('add', 'proof.yaml');
  expect(r.cli(['lint'])).toEqual({ code: 0, out: '', err: '' });
  r.write(
    'proof.yaml',
    `${tasks}${coverage}exempt: {scripts/verify-x.sh: manual, scripts/verify-y.sh: external}\n`,
  );
  r.git('add', 'proof.yaml');
  expect(r.cli(['lint'])).toEqual({ code: 0, out: '', err: '' });
});

test('lint preserves finding order, absent exemptions and sticky projections', () => {
  const r = new Repo();
  repos.push(r);
  r.commit({
    'proof.yaml': JSON.stringify({
      version: 1,
      project: 'fixture',
      tasks: {
        first: {
          run: 'true',
          inputs: [
            'gone/**',
            { path: 'absent.json', json: ['name'] },
            '!absent.json',
            { 'imports-of': 'missing.ts' },
            { maestro: 'missing.yaml' },
            'src/**',
            '!src/**',
            'src/owned.ts',
            { path: 'config.json', json: ['name'] },
            '!config.json',
            'absent-glob/**',
          ],
        },
        second: {
          run: 'true',
          inputs: ['src/owned.ts', '!src/**', { 'imports-of': 'entry.ts' }],
        },
      },
      coverage: ['z/**', 'src/**', '**/*.ts', 'nothing/**'],
      exempt: {
        'src/owned.ts': 'manual',
        'absent-glob/file': 'manual',
        'absent.json': 'manual',
        'missing.ts': 'manual',
        'missing.yaml': 'manual',
        'config.json': 'manual',
        'z/*.ts': 'manual',
      },
    }),
    'z/unowned.ts': '',
    'src/unowned.ts': '',
    'src/owned.ts': '',
    'entry.ts': "import './src/owned';",
    'config.json': '{"name":"fixture"}',
  });
  expect(r.cli(['lint'])).toEqual({
    code: 1,
    err: '',
    out:
      "task 'first': unmatched input 'gone/**'\n" +
      "task 'first': missing input 'absent.json'\n" +
      "task 'first': missing input 'missing.ts'\n" +
      "task 'first': missing input 'missing.yaml'\n" +
      "task 'first': unmatched input 'absent-glob/**'\n" +
      "coverage: unmatched pattern 'nothing/**'\n" +
      "unowned 'z/unowned.ts'\n" +
      "unowned 'src/unowned.ts'\n" +
      "exempt 'src/owned.ts': selected by task 'first'; the task owns it, drop the exemption\n" +
      "exempt 'src/owned.ts': selected by task 'second'; the task owns it, drop the exemption\n" +
      "exempt 'absent-glob/file': no tracked file\n" +
      "exempt 'absent-glob/file': selected by task 'first'; the task owns it, drop the exemption\n" +
      "exempt 'absent.json': no tracked file\n" +
      "exempt 'absent.json': selected by task 'first'; the task owns it, drop the exemption\n" +
      "exempt 'missing.ts': no tracked file\n" +
      "exempt 'missing.ts': selected by task 'first'; the task owns it, drop the exemption\n" +
      "exempt 'missing.yaml': no tracked file\n" +
      "exempt 'config.json': selected by task 'first'; the task owns it, drop the exemption\n" +
      "exempt 'z/*.ts': no tracked file\n",
  });
});

test('lint names traced exclusions without changing selection or keys', () => {
  const r = new Repo();
  repos.push(r);
  const leaf = 'packages/db/__tests__/fixture.ts';
  const trace = { 'imports-of': 'entry.ts' };
  const declare = (inputs: unknown[]) =>
    JSON.stringify({
      version: 1,
      project: 'fixture',
      tasks: { verify: { run: 'bun --no-install entry.ts', inputs } },
    });
  const a = r.commit({
    'proof.yaml': declare([trace, '!packages/db/__tests__/**']),
    'package.json': JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] }),
    'packages/db/package.json': JSON.stringify({
      name: '@fixture/db',
      exports: { './testing/fixture': './__tests__/fixture.ts' },
    }),
    [leaf]: 'export const value = 1;',
    'entry.ts': "import { value } from '@fixture/db/testing/fixture'; console.log(value);",
  });
  const planned = r.cli(['plan', '--json'], { PROOF_STATE_DIR: join(r.path, '.git/state') });
  expect(planned.code, planned.err).toBe(0);
  expect(JSON.parse(planned.out)[0].key).toBe(
    '6ab9faf618dbc52528bb2faa9ca3c3b3d473ad9e0be89bf1afa9fa14e7decc0b',
  );
  expect(r.cli(['lint'])).toEqual({
    code: 1,
    err: '',
    out: `task 'verify': '!packages/db/__tests__/**' removes '${leaf}' traced by imports-of 'entry.ts'\n`,
  });
  const b = r.commit({ [leaf]: 'export const value = 2;' });
  const c = r.commit({ 'entry.ts': "import '@fixture/db/testing/fixture';" });
  expect(
    r.check([
      { name: 'excluded', from: a, to: b, expect: [] },
      { name: 'entry', from: b, to: c, expect: ['verify'] },
    ]).code,
  ).toBe(0);
  for (const inputs of [
    [trace, '!**/__tests__/**', leaf],
    [trace, '!**/__tests__/**', trace],
    ['!**/__tests__/**', trace],
    ['entry.ts', leaf, '!**/__tests__/**'],
  ]) {
    r.commit({ 'proof.yaml': declare(inputs) });
    expect(r.cli(['lint'])).toEqual({ code: 0, out: '', err: '' });
  }
  r.commit({ 'proof.yaml': declare([trace, '!**/__tests__/**', leaf, `!${leaf}`]) });
  expect(r.cli(['lint']).out).toBe(
    `task 'verify': '!${leaf}' removes '${leaf}' traced by imports-of 'entry.ts'\n`,
  );
});

test('lint names Maestro origins and accepts restored projections', () => {
  const r = new Repo();
  repos.push(r);
  const declare = (inputs: unknown[]) =>
    JSON.stringify({
      version: 1,
      project: 'fixture',
      tasks: { verify: { run: 'true', inputs } },
    });
  const trace = { maestro: 'flows/main.yaml' };
  r.commit({
    'proof.yaml': declare([trace, '!leaf.js']),
    'flows/main.yaml': 'appId: fixture\n---\n- runFlow: nested.yaml\n',
    'flows/nested.yaml': 'appId: fixture\n---\n- runScript: ../leaf.js\n',
    'leaf.js': 'console.log(1);',
    'entry.ts': "import './config.json';",
    'config.json': '{"name":"fixture"}',
  });
  expect(r.cli(['lint'])).toEqual({
    code: 1,
    err: '',
    out: "task 'verify': '!leaf.js' removes 'leaf.js' traced by maestro 'flows/main.yaml'\n",
  });
  for (const restore of ['leaf.js', trace]) {
    r.commit({ 'proof.yaml': declare([trace, '!leaf.js', restore]) });
    expect(r.cli(['lint']).code).toBe(0);
  }
  r.commit({
    'proof.yaml': declare([
      { 'imports-of': 'entry.ts' },
      '!config.json',
      { path: 'config.json', json: ['name'] },
    ]),
  });
  expect(r.cli(['lint'])).toEqual({ code: 0, out: '', err: '' });
});

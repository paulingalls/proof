import { afterEach, expect, test } from 'bun:test';
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

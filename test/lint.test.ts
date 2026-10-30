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

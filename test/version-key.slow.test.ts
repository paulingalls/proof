import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from './support/repo';

for (const dir of ['', 'packages/group/deep/']) {
  test(`manifest version exclusion and exact bytes at ${dir || 'root'}`, () => {
    const r = new Repo();
    const state = mkdtempSync(join(tmpdir(), 'proof-version-'));
    const path = `${dir}package.json`;
    const base = {
      name: 'pkg',
      version: '1',
      scripts: { test: 'true', version: '0' },
      exports: { default: './entry', bun: './entry' },
    };
    const bytes = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
    const original = bytes(base);
    const readers = ['direct', 'glob', 'path'];
    const inputs = [{ 'imports-of': `${dir}entry.ts` }, `${dir}*package.json`, path];
    const task = (inputs: unknown[]) => ({
      run: `printf '%s' "$EXPECTED" | cmp - ${path}`,
      inputs,
      env: ['EXPECTED'],
    });
    const tasks = Object.fromEntries(readers.map((id, i) => [id, task([inputs[i]])]));
    Object.assign(tasks, {
      version: { run: 'true', inputs: [{ path, json: ['version'] }] },
      both: { run: 'true', inputs: [path, { path, json: ['version'] }] },
      other: { run: 'true', inputs: ['controls/other-package.json'] },
    });
    const cli = (args: string[], EXPECTED = original) => {
      const result = r.cli(args, { PROOF_STATE_DIR: state, EXPECTED });
      expect(result.code, result.err + result.out).toBe(0);
      return result.out;
    };
    try {
      r.commit({
        'proof.yaml': JSON.stringify({ version: 1, project: 'versions', tasks }),
        ...(dir ? { 'package.json': '{"workspaces":["packages/group/*"]}' } : {}),
        [path]: original,
        [`${dir}entry.ts`]: "import './package.json';",
        'controls/other-package.json': '{"version":1}',
      });
      expect(cli(['run'])).toContain('proof published');
      const from = r.git('rev-parse', 'HEAD');
      r.commit({ [path]: bytes({ ...base, version: '2' }) });
      for (const id of readers) {
        expect(cli(['plan'])).toContain(`PROVEN ${id}`);
        expect(cli(['why', id])).toContain('no inputs changed');
      }
      for (const id of ['version', 'both']) {
        expect(cli(['plan'])).toContain(`RUN ${id}`);
        expect(cli(['why', id])).toContain(`changed member ${path} version`);
      }
      r.git('reset', '--hard', from);
      for (const staged of [false, true]) {
        const changed = bytes({ ...base, version: '2' });
        r.write(path, changed);
        if (staged) r.git('add', path);
        const why = cli(['why', 'path']);
        expect(why).toContain(`dirty input '${path}'`);
        expect(why).toContain('no inputs changed');
        expect(cli(['run', '--tasks', 'path'], changed)).toContain(
          'green path; no proof published',
        );
        r.git('reset', '--hard', from);
        expect(cli(['plan'])).toContain('PROVEN path');
      }
      const cases = [];
      for (const [name, content, expected] of [
        ['scripts', bytes({ ...base, scripts: { test: 'false' } }), readers],
        ['custom', bytes({ ...base, custom: true }), readers],
        ['nested', bytes({ ...base, scripts: { test: 'true', version: '2' } }), readers],
        ['layout', JSON.stringify(base), readers],
        ['order', bytes({ ...base, exports: { bun: './entry', default: './entry' } }), readers],
        ['invalid', '{"version":', [...readers, 'version', 'both']],
        ['non-object', '[]', [...readers, 'version', 'both']],
      ] as const) {
        const to = r.commit({ [path]: content });
        cases.push({ name, from, to, expect: [...new Set([...expected, 'both'])] });
      }
      const other = r.commit({ [path]: original, 'controls/other-package.json': '{"version":2}' });
      cases.push({ name: 'other JSON', from, to: other, expect: ['other'] });
      const result = r.check(cases);
      expect(result.code, result.err + result.out).toBe(0);
      r.commit({ [path]: '[]' });
      for (const id of readers) cli(['record', id, '--outcome', 'green']);
      for (const id of readers) expect(cli(['plan'])).toContain(`PROVEN ${id}`);
      r.commit({ [path]: '[1]' });
      for (const id of readers) {
        expect(cli(['plan'])).toContain(`RUN ${id}`);
        expect(cli(['why', id])).toContain(`changed file ${path}`);
      }
      r.commit({ [path]: '{"version":' });
      for (const id of readers) cli(['record', id, '--outcome', 'green']);
      r.commit({ [path]: '{"version":2' });
      for (const id of readers) expect(cli(['why', id])).toContain(`changed file ${path}`);
      r.commit({ [`${dir}entry.ts`]: "import 'pkg';" });
      expect(cli(['why', 'direct'])).toMatch(/undecidable:.*SyntaxError/);
    } finally {
      r.close();
      rmSync(state, { recursive: true, force: true });
    }
  });
}

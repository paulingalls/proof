import { declarations } from './declarations';
import { RefTree } from './git';
import { key } from './key';

type Case = { name: string; from: string; to: string; expect: string[] };

export async function check(path: string) {
  const cases = Bun.YAML.parse(await Bun.file(path).text()) as Case[];
  let failed = false;
  for (const c of cases) {
    const from = new RefTree(c.from);
    const to = new RefTree(c.to);
    const oldTasks = declarations(from);
    const actual = new Set<string>();
    for (const [id, task] of declarations(to)) {
      const old = oldTasks.get(id);
      const current = key(id, task, to);
      if (current.reason) console.log(`  RUN ${id}: ${current.reason}`);
      if (!old || current.reason || key(id, old, from).key !== current.key) actual.add(id);
    }
    const missing = [...new Set(c.expect)].filter((id) => !actual.has(id));
    const extra = [...actual].filter((id) => !c.expect.includes(id));
    const pass = !missing.length && !extra.length;
    console.log(`${pass ? 'PASS' : 'FAIL'} ${c.name}`);
    if (!pass) {
      failed = true;
      console.log(`  missing: ${missing.join(', ')}\n  extra: ${extra.join(', ')}`);
    }
  }
  return failed ? 1 : 0;
}

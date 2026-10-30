import { declarations, fields, mapping, text } from './declarations';
import { RefTree } from './git';
import { key } from './key';

type Case = { name: string; from: string; to: string; expect: string[] };

export async function check(path: string) {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(await Bun.file(path).text());
  } catch (error) {
    throw new Error(`cases '${path}': ${error}`);
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error(`cases '${path}': expected a nonempty sequence`);
  }
  const cases: Case[] = parsed.map((entry, index) => {
    const context = `cases '${path}' entry ${index + 1}`;
    const c = mapping(entry, context);
    fields(c, ['name', 'from', 'to', 'expect'], context);
    if (!Array.isArray(c.expect)) throw new Error(`${context}: expect must be a string list`);
    return {
      name: text(c.name, `${context} name`),
      from: text(c.from, `${context} from`),
      to: text(c.to, `${context} to`),
      expect: c.expect.map((id) => text(id, `${context} expect`)),
    };
  });
  let failed = false;
  for (const c of cases) {
    const from = new RefTree(c.from);
    const to = new RefTree(c.to);
    const oldTasks = declarations(from);
    const actual = new Set<string>();
    const reasons: string[] = [];
    for (const [id, task] of declarations(to)) {
      const old = oldTasks.get(id);
      const current = key(id, task, to);
      if (current.reason) reasons.push(`  RUN ${id}: ${current.reason}`);
      if (!old || current.reason || key(id, old, from).key !== current.key) actual.add(id);
    }
    const missing = [...new Set(c.expect)].filter((id) => !actual.has(id));
    const extra = [...actual].filter((id) => !c.expect.includes(id));
    const pass = !missing.length && !extra.length;
    console.log(`${pass ? 'PASS' : 'FAIL'} ${c.name}`);
    for (const reason of reasons) console.log(reason);
    if (!pass) {
      failed = true;
      console.log(`  missing: ${missing.join(', ')}\n  extra: ${extra.join(', ')}`);
    }
  }
  return failed ? 1 : 0;
}

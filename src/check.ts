import { declarations, fields, mapping, text } from './declarations';
import { RefTree } from './git';
import { key } from './key';
import { refuseDuplicateKeys } from './yaml-keys';

type Case = { name: string; from: string; to: string; expect: string[] };

export async function check(path: string) {
  let parsed: unknown;
  try {
    const source = await Bun.file(path).text();
    parsed = Bun.YAML.parse(source);
    refuseDuplicateKeys(source);
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
  const refs = new Map<string, Map<string, ReturnType<typeof key>>>();
  function keys(ref: string) {
    let computed = refs.get(ref);
    if (!computed) {
      const tree = new RefTree(ref);
      computed = new Map(
        [...declarations(tree).tasks].map(([id, task]) => [id, key(id, task, tree)]),
      );
      refs.set(ref, computed);
    }
    return computed;
  }
  let failed = false;
  for (const c of cases) {
    const from = keys(c.from);
    const to = keys(c.to);
    const actual = new Set<string>();
    const reasons: string[] = [];
    // A case assumes every task proven at `from`; an undecidable one there would be selected
    // whatever the pair changed, so the case could pass without testing it.
    const unproven: string[] = [];
    for (const [id, old] of from) {
      if (old.reason) unproven.push(`  from ${c.from}: ${id} undecidable: ${old.reason}`);
    }
    for (const [id, current] of to) {
      const old = from.get(id);
      if (current.reason) reasons.push(`  RUN ${id}: ${current.reason}`);
      if (!old || current.reason || old.key !== current.key) actual.add(id);
    }
    const missing = [...new Set(c.expect)].filter((id) => !actual.has(id));
    const extra = [...actual].filter((id) => !c.expect.includes(id));
    const pass = !missing.length && !extra.length && !unproven.length;
    console.log(`${pass ? 'PASS' : 'FAIL'} ${c.name}`);
    for (const reason of [...unproven, ...reasons]) console.log(reason);
    if (!pass) {
      failed = true;
      console.log(`  missing: ${missing.join(', ')}\n  extra: ${extra.join(', ')}`);
    }
  }
  return failed ? 1 : 0;
}

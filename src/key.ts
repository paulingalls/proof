import type { Task } from './declarations';
import type { RefTree, Scope } from './git';

type Key = { key: string; reason?: never } | { key?: never; reason: string };

function select(task: Task, inventory: Iterable<string>) {
  const available = [...inventory];
  const paths = new Set<string>();
  for (const pattern of task.inputs) {
    const negative = pattern.startsWith('!');
    const glob = new Bun.Glob(negative ? pattern.slice(1) : pattern);
    let matched = false;
    for (const path of available) {
      if (glob.match(path)) {
        matched = true;
        if (negative) paths.delete(path);
        else paths.add(path);
      }
    }
    if (!matched) return { reason: `unmatched input '${pattern}'` };
  }
  return { paths };
}

function selects(task: Task, path: string) {
  let selected = false;
  for (const pattern of task.inputs) {
    const negative = pattern.startsWith('!');
    if (new Bun.Glob(negative ? pattern.slice(1) : pattern).match(path)) selected = !negative;
  }
  return selected;
}

// The literal directory before a pattern's first glob character: a superset for git pathspecs.
function prefix(pattern: string) {
  const glob = pattern.search(/[*?[{\\]/);
  if (glob === -1) return pattern;
  return pattern.slice(0, pattern.lastIndexOf('/', glob) + 1) || undefined;
}

export function scope(tasks: Iterable<Task>, declarations: string[]): Scope {
  const list = [...tasks];
  const patterns = [...declarations, ...list.flatMap((t) => t.inputs)].filter(
    (p) => !p.startsWith('!'),
  );
  const prefixes = patterns.map(prefix);
  return {
    selects: (path) =>
      declarations.some((d) => new Bun.Glob(d).match(path)) || list.some((t) => selects(t, path)),
    prefixes: prefixes.includes(undefined) ? undefined : [...new Set(prefixes as string[])],
  };
}

export function key(id: string, task: Task, tree: RefTree, dirty: string[] = []): Key {
  if (dirty.length) {
    const selection = select(task, new Set([...tree.files.keys(), ...dirty]));
    const path = dirty.find((path) => selection.paths?.has(path));
    if (path) return { reason: `dirty input '${path}'` };
  }
  const selection = select(task, tree.files.keys());
  if (!selection.paths) return { reason: selection.reason };
  const selected = [...selection.paths].map((path) => [path, tree.files.get(path)] as const);
  selected.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = new Bun.CryptoHasher('sha256')
    .update(JSON.stringify([1, id, { run: task.run }, selected]))
    .digest('hex');
  return { key: hash };
}

import type { Task } from './declarations';
import type { RefTree } from './git';

type Key = { key: string; reason?: never } | { key?: never; reason: string };

export function key(id: string, task: Task, tree: RefTree): Key {
  const paths = new Set<string>();
  for (const pattern of task.inputs) {
    const negative = pattern.startsWith('!');
    const glob = new Bun.Glob(negative ? pattern.slice(1) : pattern);
    let matched = false;
    for (const path of tree.files.keys()) {
      if (glob.match(path)) {
        matched = true;
        if (negative) paths.delete(path);
        else paths.add(path);
      }
    }
    if (!matched) return { reason: `unmatched input '${pattern}'` };
  }
  const selected = [...paths].map((path) => [path, tree.files.get(path)] as const);
  selected.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = new Bun.CryptoHasher('sha256')
    .update(JSON.stringify([1, id, { run: task.run }, selected]))
    .digest('hex');
  return { key: hash };
}

import type { Task } from './declarations';
import type { RefTree } from './git';

export function key(id: string, task: Task, tree: RefTree): string {
  const paths = new Set<string>();
  for (const pattern of task.inputs) {
    const negative = pattern.startsWith('!');
    const glob = new Bun.Glob(negative ? pattern.slice(1) : pattern);
    for (const path of tree.files.keys()) {
      if (glob.match(path)) {
        if (negative) paths.delete(path);
        else paths.add(path);
      }
    }
  }
  const selected = [...paths].map((path) => [path, tree.files.get(path)] as const);
  selected.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return new Bun.CryptoHasher('sha256')
    .update(JSON.stringify([1, id, { run: task.run }, selected]))
    .digest('hex');
}

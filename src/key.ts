import type { Task } from './declarations';
import type { RefTree } from './git';

export function key(id: string, task: Task, tree: RefTree): string {
  const selected = [...tree.files].filter(([path]) =>
    task.inputs.some((pattern) => new Bun.Glob(pattern).match(path)),
  );
  selected.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return new Bun.CryptoHasher('sha256')
    .update(JSON.stringify([1, id, { run: task.run }, selected]))
    .digest('hex');
}

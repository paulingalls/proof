import type { Task } from './declarations';
import { dirtyPaths, type RefTree } from './git';
import { scope, selection } from './key';
import { workingFile } from './sandbox';

export function providerMismatch(task: Task, tree: RefTree) {
  const dirty = dirtyPaths(scope([task], [], tree));
  const paths = new Set([...selection(task, tree), ...selection(task, tree, dirty)]);
  for (const path of paths) {
    const mode = tree.modes.get(path);
    if (mode === '120000' && !dirty.includes(path)) continue;
    const working = workingFile(path);
    if (mode === undefined) {
      if (working) return path;
    } else if (
      !working ||
      working.executable !== (mode === '100755') ||
      !working.bytes.equals(tree.raw(path))
    )
      return path;
  }
}

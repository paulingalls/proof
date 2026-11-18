import type { Task } from './declarations';
import { dirtyPaths, RefTree } from './git';
import { selection } from './key';
import { workingFile } from './sandbox';

export function providerMismatch(task: Task, tree: RefTree) {
  const dirty = new Set(dirtyPaths());
  const index = RefTree.index();
  const paths = new Set([...selection(task, tree), ...selection(task, tree, [...dirty])]);
  for (const path of paths) {
    const mode = tree.modes.get(path);
    if (
      mode !== undefined &&
      !dirty.has(path) &&
      index.files.get(path) === tree.files.get(path) &&
      index.modes.get(path) === mode
    )
      continue;
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

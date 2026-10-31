import { declarations } from './declarations';
import { RefTree } from './git';
import { planTree } from './plan';

export async function status(ref: string) {
  const tree = new RefTree(ref);
  const { project, tasks } = declarations(tree);
  return planTree({ tree, project, tasks, dirty: [] }, (task) => ({
    trusted: task.links ?? [],
    escapes: [],
    modules: new Map(),
  }));
}

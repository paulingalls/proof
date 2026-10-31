import { declarations, selectTasks } from './declarations';
import { RefTree } from './git';
import { planTree } from './plan';

export async function status(ref: string, set?: string) {
  const tree = new RefTree(ref);
  const { project, tasks } = declarations(tree);
  return planTree({ tree, project, tasks: selectTasks(tasks, set), dirty: [] }, (task) => ({
    trusted: task.links ?? [],
    escapes: [],
    modules: new Map(),
  }));
}

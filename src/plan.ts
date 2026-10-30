import type { Task } from './declarations';
import { declarationPaths, declarations, dirtyDeclaration } from './declarations';
import { dirtyPaths, RefTree } from './git';
import { key, scope } from './key';
import { Store } from './store';

export function plan() {
  const tree = new RefTree('HEAD');
  const { project, tasks, include } = declarations(tree);
  const dirty = dirtyPaths(scope(tasks.values(), declarationPaths(include)));
  const declaration = dirtyDeclaration(dirty, include);
  const store = new Store();
  try {
    return [...tasks].map(([task, decl]) => {
      return decide(task, decl, tree, dirty, declaration, project, store);
    });
  } finally {
    store.close();
  }
}

export function decide(
  task: string,
  decl: Task,
  tree: RefTree,
  dirty: string[],
  declaration: string | undefined,
  project: string,
  store: Store,
) {
  if (declaration)
    return { task, state: 'RUN', reason: `undecidable: dirty declaration '${declaration}'` };
  const current = key(task, decl, tree, dirty);
  if (current.key === undefined)
    return { task, state: 'RUN', reason: `undecidable: ${current.reason}` };
  const proof = store.proof(project, task, current.key);
  if (proof?.red_commit)
    return {
      task,
      state: 'RUN',
      reason: `contested: red at ${proof.red_commit} on ${proof.red_host} after green`,
    };
  return proof
    ? {
        task,
        state: 'PROVEN',
        reason: `proven at ${proof.commit} on ${proof.host} ${proof.finished_at}`,
      }
    : { task, state: 'RUN', reason: 'no proof for key' };
}

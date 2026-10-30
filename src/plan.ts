import type { Task } from './declarations';
import { declarationPaths, declarations, dirtyDeclaration } from './declarations';
import { dirtyPaths, RefTree } from './git';
import { key, scope } from './key';
import { inspectLinks } from './sandbox';
import { Store } from './store';

export function plan() {
  const { tree, project, tasks, dirty, declaration } = currentTree();
  const store = new Store();
  try {
    return [...tasks].map(([task, decl]) =>
      decide(task, decl, tree, dirty, declaration, project, store),
    );
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
  inspection = inspectLinks(decl.links ?? [], tree.files.keys()),
) {
  const links = [
    ...(inspection.trusted.length ? [`trusted links: ${inspection.trusted.join(', ')}`] : []),
    ...inspection.escapes,
  ]
    .map((reason) => `; ${reason}`)
    .join('');
  const decision = decideProof();
  return { ...decision, reason: decision.reason + links };
  function decideProof() {
    if (declaration)
      return { task, state: 'RUN', reason: `undecidable: dirty declaration '${declaration}'` };
    const current = key(task, decl, tree, dirty);
    if (current.key === undefined)
      return { task, state: 'RUN', reason: `undecidable: ${current.reason}` };
    if (inspection.escapes.length) return { task, state: 'RUN', reason: 'untrusted links' };
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
}

export function currentTree() {
  const tree = new RefTree('HEAD');
  let document = declarations(tree);
  let dirty = dirtyPaths(scope(document.tasks.values(), declarationPaths(document.include)));
  const declaration = dirtyDeclaration(dirty, document.include);
  if (declaration) {
    document = declarations(tree, true);
    dirty = dirtyPaths(scope(document.tasks.values(), declarationPaths(document.include)));
  }
  return { tree, ...document, dirty, declaration };
}

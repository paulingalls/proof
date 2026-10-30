import { declarations } from './declarations';
import { dirtyPaths, RefTree } from './git';
import { key } from './key';
import { Store } from './store';

export function plan() {
  const tree = new RefTree('HEAD');
  const { project, tasks, include } = declarations(tree);
  const dirty = dirtyPaths();
  const dirtyDeclaration = dirty.find(
    (path) => path === 'proof.yaml' || (include !== undefined && new Bun.Glob(include).match(path)),
  );
  const store = new Store();
  try {
    return [...tasks].map(([task, declaration]) => {
      if (dirtyDeclaration)
        return {
          task,
          state: 'RUN',
          reason: `undecidable: dirty declaration '${dirtyDeclaration}'`,
        };
      const current = key(task, declaration, tree, dirty);
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
    });
  } finally {
    store.close();
  }
}

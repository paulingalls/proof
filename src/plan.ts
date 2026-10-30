import { declarations } from './declarations';
import { RefTree } from './git';
import { key } from './key';
import { Store } from './store';

export function plan() {
  const tree = new RefTree('HEAD');
  const { project, tasks } = declarations(tree);
  const store = new Store();
  try {
    return [...tasks].map(([task, declaration]) => {
      const current = key(task, declaration, tree);
      if (current.key === undefined)
        return { task, state: 'RUN', reason: `undecidable: ${current.reason}` };
      const proof = store.proof(project, task, current.key);
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

import type { Task } from './declarations';
import { declarationPaths, declarations, dirtyDeclaration } from './declarations';
import { dirtyPaths, RefTree } from './git';
import { source } from './imports';
import { key, scope } from './key';
import { inspectLinks } from './sandbox';
import { Store } from './store';
import { workspaces } from './workspaces';

export async function plan() {
  const { tree, project, tasks, dirty, declaration } = currentTree();
  const store = await Store.open();
  try {
    const rows = [];
    for (const [task, decl] of tasks)
      rows.push(await decide(task, decl, tree, dirty, declaration, project, store));
    return rows;
  } catch (error) {
    try {
      await store.close();
    } catch {
      /* Preserve the command failure. */
    }
    throw error;
  } finally {
    await store.close();
  }
}

export function inspectTaskLinks(
  task: Task,
  tree: RefTree,
  dirty: string[],
  materialized?: ReturnType<typeof inspectLinks>,
) {
  let view: ReturnType<typeof source> | undefined;
  return inspectLinks(
    task.links ?? [],
    tree.files.keys(),
    () => {
      view ??= source(tree, dirty.length ? dirty : undefined);
      return workspaces(view).names();
    },
    materialized?.modules,
  );
}

export async function decide(
  task: string,
  decl: Task,
  tree: RefTree,
  dirty: string[],
  declaration: string | undefined,
  project: string,
  store: Store,
  inspection = inspectTaskLinks(decl, tree, dirty),
) {
  const links = [
    ...(inspection.trusted.length ? [`trusted links: ${inspection.trusted.join(', ')}`] : []),
    ...inspection.escapes,
  ]
    .map((reason) => `; ${reason}`)
    .join('');
  const decision = await decideProof();
  return {
    ...decision,
    reason: decision.reason + links,
    ...(decision.state === 'RUN' && decl.needs?.length ? { providers: decl.needs } : {}),
  };
  async function decideProof() {
    if (declaration)
      return { task, state: 'RUN', reason: `undecidable: dirty declaration '${declaration}'` };
    const current = key(task, decl, tree, dirty);
    if (current.key === undefined)
      return { task, state: 'RUN', reason: `undecidable: ${current.reason}` };
    if (inspection.escapes.length) return { task, state: 'RUN', reason: 'untrusted links' };
    const proof = await store.proof(project, task, current.key);
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
  let dirty = dirtyPaths(scope(document.tasks.values(), declarationPaths(document.include), tree));
  const declaration = dirtyDeclaration(dirty, document.include);
  if (declaration) {
    document = declarations(tree, true);
    dirty = dirtyPaths(scope(document.tasks.values(), declarationPaths(document.include), tree));
  }
  return { tree, ...document, dirty, declaration };
}

export function renderDecision(row: Awaited<ReturnType<typeof decide>>) {
  return `${row.state} ${row.task}: ${row.reason}${row.providers?.length ? `; providers: ${row.providers.join(', ')}` : ''}`;
}

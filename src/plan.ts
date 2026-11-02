import type { Task } from './declarations';
import { declarations, dirtyDeclaration, selectTasks } from './declarations';
import { generate } from './generate';
import { dirtyPaths, RefTree, resolveRef } from './git';
import { source } from './imports';
import { key, selection } from './key';
import { inspectLinks } from './sandbox';
import { localDay, Store } from './store';
import { estimate, format, pricesFor } from './timing';
import { workspaces } from './workspaces';

export const STAGED_SUFFIX = ' (staged)';

export async function plan(set?: string, since?: string, price = false) {
  const baseline = since === undefined ? undefined : new Since(since);
  const view = currentTree();
  let summary: string | undefined;
  const rows = await planTree(
    { ...view, tasks: selectTasks(view.tasks, set) },
    undefined,
    baseline,
    price
      ? (value) => {
          summary = value;
        }
      : undefined,
  );
  return { rows, summary };
}

export async function planTree(
  {
    tree,
    project,
    tasks,
    dirty,
    declaration,
  }: {
    tree: RefTree;
    project: string;
    tasks: Map<string, Task>;
    dirty: string[];
    declaration?: string;
  },
  inspect?: (task: Task) => ReturnType<typeof inspectTaskLinks>,
  since?: Since,
  summarize?: (summary: string) => void,
) {
  const inspections = new Map<string, ReturnType<typeof inspectTaskLinks>>();
  const inspectPlanLinks =
    inspect ??
    ((decl: Task) => {
      const links = JSON.stringify(decl.links ?? []);
      let inspection = inspections.get(links);
      if (!inspection) {
        inspection = inspectTaskLinks(decl, tree, dirty);
        inspections.set(links, inspection);
      }
      return inspection;
    });
  const store = await Store.open(project);
  try {
    const rows = [];
    for (const [task, decl] of tasks)
      rows.push(
        await decide(
          task,
          decl,
          tree,
          dirty,
          declaration,
          project,
          store,
          inspectPlanLinks(decl),
          false,
          since,
        ),
      );
    if (summarize) {
      const today = localDay(new Date());
      const history = await store.history(project, today, today);
      const running = rows.filter((row) => row.state === 'RUN').map((row) => row.task);
      const cost = estimate(running, pricesFor(history.results));
      const proven = rows.filter((row) => row.state === 'PROVEN').length;
      const unreached = rows.filter((row) => row.state === 'UNREACHED').length;
      summarize(
        `summary: RUN ${running.length}, PROVEN ${proven}, UNREACHED ${unreached}; estimated ${format(cost.seconds / 60)}m; unpriced ${cost.unpriced.length}`,
      );
    }
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
  fresh = false,
  since?: Since,
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
    const identity = { task, key: current.key };
    if (inspection.escapes.length) return { ...identity, state: 'RUN', reason: 'untrusted links' };
    if (fresh) return { ...identity, state: 'RUN', reason: 'fresh execution requested' };
    const proof = await store.proof(project, task, current.key);
    if (proof?.red_commit)
      return {
        ...identity,
        state: 'RUN',
        reason: `contested: red at ${proof.red_commit} on ${proof.red_host} after green`,
      };
    if (proof)
      return {
        ...identity,
        state: 'PROVEN',
        reason: `proven at ${proof.commit} on ${proof.host} ${proof.finished_at}`,
      };
    return {
      ...identity,
      ...(since?.compare(task, current.key) ?? { state: 'RUN', reason: 'no proof for key' }),
    };
  }
}

export class Since {
  private readonly tree: RefTree;
  private tasks?: Map<string, Task>;
  private error?: string;
  private readonly keys = new Map<string, ReturnType<typeof key>>();

  constructor(readonly ref: string) {
    this.tree = new RefTree(ref);
  }

  compare(id: string, current: string) {
    if (!this.tasks && !this.error) {
      try {
        this.tasks = declarations(this.tree).tasks;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    }
    if (this.error) return { state: 'RUN', reason: `undecidable at ${this.ref}: ${this.error}` };
    const task = this.tasks?.get(id);
    if (!task) return { state: 'RUN', reason: `task absent at ${this.ref}` };
    let old = this.keys.get(id);
    if (!old) {
      old = key(id, task, this.tree);
      this.keys.set(id, old);
    }
    if (old.key === undefined)
      return { state: 'RUN', reason: `undecidable at ${this.ref}: ${old.reason}` };
    return old.key === current
      ? { state: 'UNREACHED', reason: `unreached since ${this.ref}` }
      : { state: 'RUN', reason: `key changed since ${this.ref}` };
  }
}

let committed: { tree: RefTree; document: ReturnType<typeof declarations> } | undefined;

export function currentTree() {
  if (committed?.tree.commit !== resolveRef('HEAD')) {
    const tree = new RefTree('HEAD');
    committed = { tree, document: declarations(tree) };
  }
  const { tree } = committed;
  let document = committed.document;
  const dirty = dirtyPaths();
  const declaration =
    dirtyDeclaration(dirty, document.include) ?? dirtyGenerated(tree, document, dirty);
  if (declaration) document = declarations(tree, true);
  return { tree, ...document, dirty, declaration };
}

export function dirtyGenerated(
  tree: RefTree,
  document: ReturnType<typeof declarations>,
  dirty: string[],
) {
  if (!document.generate || !dirty.length) return undefined;
  const selected = selection(document.generate, tree, dirty);
  if (!dirty.some((path) => selected.has(path))) return undefined;
  const working = generate(document.generate, tree, dirty, document.project);
  const before = new Map(document.generated);
  const after = new Map(working);
  const name = [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .find((name) => before.get(name) !== after.get(name));
  return name === undefined ? undefined : `proof.yaml generate: ${name}`;
}

export function renderDecision(row: Awaited<ReturnType<typeof decide>>) {
  return `${row.state} ${row.task}: ${row.reason}${row.providers?.length ? `; providers: ${row.providers.join(', ')}` : ''}`;
}

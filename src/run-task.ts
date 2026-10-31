import { hostname } from 'node:os';
import { declarationPaths } from './declarations';
import { dirtyPaths, resolveRef } from './git';
import { key, scope, selection } from './key';
import { logSuffix } from './logs';
import { currentTree, decide, inspectTaskLinks, renderDecision, STAGED_SUFFIX } from './plan';
import { providerMismatch } from './provider-inputs';
import type { Providers } from './providers';
import type { RunProcesses } from './run-process';
import { Sandbox } from './sandbox';
import type { Store } from './store';

type Context = {
  snapshot?: ReturnType<typeof currentTree>;
  fresh: boolean;
  live: boolean;
  logFailed: () => void;
  staged: boolean;
  parent?: string;
  ids: string[];
  store: Store;
  summary: string[];
  preview: Map<string, string>;
  providerMismatches: Map<string, string>;
  processes: RunProcesses;
  providers: Providers;
  fail: () => void;
  skipped: (id: string) => void;
  retain: (needs: string[]) => void;
};
export async function runTask(
  id: string,
  {
    snapshot,
    fresh,
    live,
    logFailed,
    staged,
    parent,
    ids,
    store,
    summary,
    preview,
    providerMismatches,
    processes,
    providers,
    fail,
    skipped,
    retain,
  }: Context,
) {
  const baseline = snapshot ?? currentTree();
  let view = baseline;
  let task = view.tasks.get(id);
  if (!task) throw new Error(`undeclared task '${id}'`);
  retain(task.needs ?? []);
  if (processes.cancelled && !providers.attempted(task.needs ?? [])) return;
  let inspection = inspectTaskLinks(task, view.tree, view.dirty);
  let decision = await decide(
    id,
    task,
    view.tree,
    view.dirty,
    view.declaration,
    view.project,
    store,
    inspection,
    fresh,
  );
  if (processes.cancelled && !providers.attempted(task.needs ?? [])) return;
  const printRevision = () => {
    const rendered = renderDecision(decision);
    if (preview.get(id) !== rendered) console.log(rendered);
    preview.set(id, rendered);
  };
  printRevision();
  let started = false;
  if (decision.state !== 'PROVEN' && !processes.cancelled) {
    for (const name of task.needs ?? []) {
      if (processes.cancelled) break;
      const provider = view.providers.get(name);
      if (!provider) throw new Error(`unknown provider '${name}'`);
      if (staged && !providers.attempted([name])) {
        for (const dependent of ids) {
          const selected = view.tasks.get(dependent);
          if (!selected?.needs?.includes(name)) continue;
          const mismatch = providerMismatch(selected, view.tree);
          if (mismatch && !providerMismatches.has(dependent))
            providerMismatches.set(dependent, mismatch);
        }
      }
      started = true;
      await providers.start(name, provider);
    }
  }
  if (started) {
    view = snapshot ?? currentTree();
    task = view.tasks.get(id);
    if (!task) throw new Error(`undeclared task '${id}'`);
    retain(task.needs ?? []);
    inspection = inspectTaskLinks(task, view.tree, view.dirty);
    decision = await decide(
      id,
      task,
      view.tree,
      view.dirty,
      view.declaration,
      view.project,
      store,
      inspection,
      fresh,
    );
    printRevision();
  }
  const { tree, project, dirty, declaration } = view;
  if (decision.state === 'PROVEN') {
    skipped(id);
    summary.push(`PROVEN ${id}: ${decision.reason}`);
    return;
  }
  const blocked =
    processes.cancelled ||
    (task.needs ?? []).map((name) => providers.ready(name)).some((ready) => !ready);
  const current = declaration
    ? { reason: `dirty declaration '${declaration}'`, key: undefined }
    : key(id, task, tree);
  const dirtyInputs = fresh && key(id, task, tree, dirty).key === undefined;
  const sandbox = blocked ? undefined : new Sandbox();
  try {
    let seconds: number | null = null;
    let outcome: 'incomplete' | 'green' | 'red' = 'incomplete';
    let unbuilt: string | undefined;
    let log = '';
    try {
      sandbox?.materialize(selection(task, tree, dirty), tree, dirty, staged);
      sandbox?.link(task.links ?? [], inspection);
    } catch (error) {
      // Unattended, the backstop finishes every task it can; a person running `run` is told now.
      if (!fresh) throw error;
      unbuilt = error instanceof Error ? error.message : String(error);
    }
    if (sandbox && !unbuilt) {
      const env: Record<string, string> = {};
      for (const name of ['PATH', 'HOME', 'TMPDIR', ...(task.env ?? [])]) {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
      }
      const started = performance.now();
      const result = await processes.execute(task.run, sandbox.path, env, false, {
        project,
        task: id,
        key: current.key,
        live,
      });
      outcome =
        processes.cancelled || result.signal ? 'incomplete' : result.code === 0 ? 'green' : 'red';
      seconds = (performance.now() - started) / 1000;
      const retained = result.capture?.finish(outcome) ?? {};
      if (retained.error) logFailed();
      log = logSuffix(retained);
    }
    if (outcome !== 'green') fail();
    let unpublished = baseline.dirty.length ? `dirty path '${baseline.dirty[0]}'` : undefined;
    if (!staged && !unpublished) {
      if (resolveRef('HEAD') !== baseline.tree.commit) unpublished = 'HEAD changed';
      else {
        const changed = sandbox?.changed();
        const added = dirtyPaths(
          scope(baseline.tasks.values(), declarationPaths(baseline.include), baseline.tree),
        ).find((path) => !baseline.dirty.includes(path));
        if (changed) unpublished = `selected path changed '${changed}'`;
        else if (added) unpublished = `new dirty path '${added}'`;
      }
    }
    // Providers run in the checkout, so one can serve bytes this snapshot doesn't hold.
    const unstaged =
      staged && task.needs?.length
        ? (providerMismatches.get(id) ?? providerMismatch(task, tree))
        : undefined;
    if (unstaged) unpublished = `provider can see unstaged '${unstaged}'`;
    // The command may have changed bytes without changing the dirty path names.
    const afterDirty = [...dirty];
    const escapes = [
      ...new Set([
        ...inspection.escapes,
        ...inspectTaskLinks(task, tree, afterDirty, inspection).escapes,
      ]),
    ];
    if (escapes.length) unpublished = [unpublished, ...escapes].filter(Boolean).join('; ');
    if (current.key !== undefined) {
      const { sharing, deletedLocal, deletedShared } = await store.record(
        project,
        id,
        current.key,
        outcome,
        seconds,
        hostname(),
        staged ? `${parent}${STAGED_SUFFIX}` : tree.commit,
        unpublished !== undefined,
        dirtyInputs || unstaged !== undefined || key(id, task, tree, afterDirty).key === undefined,
        current.env,
        fresh ? 'super' : 'ordinary',
      );
      if (deletedLocal) summary.push(`deleted proof local ${id} ${current.key}`);
      if (deletedShared) summary.push(`deleted proof shared ${id} ${current.key}`);
      summary.push(
        `${outcome} ${id}${unbuilt ? `; sandbox failed: ${unbuilt}` : unpublished ? `; no proof published: ${unpublished}` : outcome === 'green' ? '; proof published' : ''}${sharing === 'local' ? '' : `; ${sharing}`}${log}`,
      );
    } else
      summary.push(
        `${outcome} ${id}; not recorded: ${current.reason}${escapes.length ? `; ${escapes.join('; ')}` : ''}${log}`,
      );
  } finally {
    sandbox?.close();
  }
}

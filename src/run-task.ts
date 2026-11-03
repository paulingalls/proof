import { hostname } from 'node:os';
import { key } from './key';
import type { Lanes } from './lanes';
import {
  type currentTree,
  decide,
  inspectTaskLinks,
  renderDecision,
  type Since,
  STAGED_SUFFIX,
} from './plan';
import { providerMismatch } from './provider-inputs';
import type { Providers } from './providers';
import { runAttempt } from './run-attempt';
import type { RunProcesses } from './run-process';
import { Sandbox } from './sandbox';
import type { Store } from './store';

export type TaskResult = {
  outcome: 'green' | 'red' | 'incomplete' | 'proven' | 'unreached';
  notRecorded: boolean;
  quiet?: boolean;
  gaps?: string[];
};

type Context = {
  lanes: Lanes;
  lane?: string;
  view: () => ReturnType<typeof currentTree>;
  refresh: () => ReturnType<typeof currentTree>;
  fresh: boolean;
  strictInputs: boolean;
  since?: Since;
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
    lanes,
    lane,
    view: currentView,
    refresh,
    fresh,
    strictInputs,
    since,
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
): Promise<TaskResult | undefined> {
  const initialPreview = preview.get(id);
  const baseline = currentView();
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
    since,
  );
  if (processes.cancelled && !providers.attempted(task.needs ?? [])) return;
  const printRevision = () => {
    const rendered = renderDecision(decision);
    if (preview.get(id) !== rendered) console.log(rendered);
    preview.set(id, rendered);
  };
  printRevision();
  let slot: number | undefined;
  let exhausted: string | undefined;
  try {
    let started = false;
    if (decision.state === 'RUN' && !processes.cancelled) {
      ({ slot, exhausted } = lanes.allocate(lane));
      for (const name of exhausted ? [] : (task.needs ?? [])) {
        if (processes.cancelled) break;
        const provider = view.providers.get(name);
        if (!provider) throw new Error(`unknown provider '${name}'`);
        if (staged && !providers.attemptedInstance(name, slot)) {
          for (const dependent of ids) {
            const selected = view.tasks.get(dependent);
            if (!selected?.needs?.includes(name)) continue;
            const mismatch = providerMismatch(selected, view.tree);
            if (mismatch && !providerMismatches.has(dependent))
              providerMismatches.set(dependent, mismatch);
          }
        }
        started = true;
        const ready = await providers.start(name, provider, slot);
        const providerLane = providers.lane(name);
        if (!ready && providerLane !== undefined && slot !== undefined)
          lanes.retire(providerLane, slot);
      }
    }
    if (started) {
      view = currentView();
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
        since,
      );
      printRevision();
    }
    const { tree, project, dirty, declaration } = view;
    if (decision.state === 'UNREACHED') {
      summary.push(renderDecision(decision));
      return { outcome: 'unreached', notRecorded: false };
    }
    if (decision.state === 'PROVEN') {
      skipped(id);
      const quiet = renderDecision(decision) === initialPreview;
      if (!quiet) summary.push(`PROVEN ${id}: ${decision.reason}`);
      return { outcome: 'proven', notRecorded: false, quiet };
    }
    const blocked =
      processes.cancelled ||
      exhausted !== undefined ||
      (task.needs ?? []).map((name) => providers.ready(name, slot)).some((ready) => !ready);
    const providerReason = blocked
      ? providers.blockedReason(id, task.needs ?? [], slot, exhausted !== undefined)
      : '';
    const current = declaration
      ? { reason: `dirty declaration '${declaration}'`, key: undefined }
      : key(id, task, tree);
    const input = key(id, task, tree, dirty);
    const dirtyInputs = fresh && input.key === undefined;
    const sandbox = blocked ? undefined : new Sandbox();
    const sandboxes = sandbox ? [sandbox] : [];
    try {
      // Dirt that reaches no input must not change what runs: the proof names the committed bytes.
      const visible = input.key === undefined ? dirty : [];
      const attemptTask = task;
      const attempt = (sandbox: Sandbox | undefined, strict: boolean) =>
        runAttempt({
          id,
          task: attemptTask,
          tree,
          visible,
          strict,
          sandbox,
          inspection,
          fresh,
          staged,
          providers,
          slot,
          processes,
          project,
          key: current.key,
          live,
          logFailed,
        });
      let result = await attempt(sandbox, strictInputs);
      const gaps =
        strictInputs && result.outcome === 'red'
          ? result.omitted.filter((path) => result.delivered.has(path))
          : [];
      if (strictInputs && result.outcome === 'red' && result.delivered.size > 0) {
        if (processes.cancelled) {
          result.outcome = 'incomplete';
          result.seconds = null;
        } else {
          const retry = new Sandbox();
          sandboxes.push(retry);
          result = await attempt(retry, false);
          if (result.outcome === 'green' && !gaps.length) gaps.push('unidentified');
        }
      }
      const { outcome, seconds, unbuilt, log } = result;
      if (outcome !== 'green') fail();
      const after = refresh();
      let unpublished = input.reason;
      if (!staged && !unpublished) {
        if (after.tree.commit !== baseline.tree.commit) unpublished = 'HEAD changed';
        else {
          // The first sandbox's baseline already spans both attempts' net checkout changes.
          const changed = sandbox?.changed();
          if (changed) unpublished = `selected path changed '${changed}'`;
          else if (after.declaration) unpublished = `dirty declaration '${after.declaration}'`;
          else unpublished = key(id, task, after.tree, after.dirty).reason;
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
          dirtyInputs ||
            unstaged !== undefined ||
            key(id, task, tree, afterDirty).key === undefined,
          current.env,
          current.dimensionValues,
          fresh ? 'super' : 'ordinary',
        );
        if (deletedLocal) summary.push(`deleted proof local ${id} ${current.key}`);
        if (deletedShared) summary.push(`deleted proof shared ${id} ${current.key}`);
        summary.push(
          `${outcome} ${id}${exhausted ? `; ${exhausted}` : unbuilt ? `; sandbox failed: ${unbuilt}` : unpublished ? `; no proof published: ${unpublished}` : outcome === 'green' ? '; proof published' : ''}${providerReason}${sharing === 'local' ? '' : `; ${sharing}`}${log}`,
        );
      } else
        summary.push(
          `${outcome} ${id}; not recorded: ${current.reason}${exhausted ? `; ${exhausted}` : ''}${providerReason}${escapes.length ? `; ${escapes.join('; ')}` : ''}${log}`,
        );
      return { outcome, notRecorded: current.key === undefined, gaps };
    } finally {
      for (const sandbox of sandboxes) {
        try {
          sandbox.close();
        } catch (error) {
          summary.push(
            `warning: sandbox cleanup failed for ${id}; left behind: ${sandbox.path}; ${error}`,
          );
        }
      }
    }
  } finally {
    lanes.release(lane, slot);
  }
}

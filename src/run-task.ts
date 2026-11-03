import { hostname } from 'node:os';
import { key, selection } from './key';
import type { Lanes } from './lanes';
import { logSuffix, notDelivered } from './logs';
import {
  type currentTree,
  decide,
  inspectTaskLinks,
  renderDecision,
  type Since,
  STAGED_SUFFIX,
} from './plan';
import { providerMismatch } from './provider-inputs';
import { BASE_ENV, type Providers } from './providers';
import type { RunProcesses } from './run-process';
import { Sandbox } from './sandbox';
import type { Store } from './store';

export type TaskResult = {
  outcome: 'green' | 'red' | 'incomplete' | 'proven' | 'unreached';
  notRecorded: boolean;
};

type Context = {
  lanes: Lanes;
  lane?: string;
  view: () => ReturnType<typeof currentTree>;
  refresh: () => ReturnType<typeof currentTree>;
  fresh: boolean;
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
      summary.push(`PROVEN ${id}: ${decision.reason}`);
      return { outcome: 'proven', notRecorded: false };
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
    try {
      let seconds: number | null = null;
      let outcome: 'incomplete' | 'green' | 'red' = 'incomplete';
      let unbuilt: string | undefined;
      let log = '';
      let selected = new Set<string>();
      let delivered = new Set<string>();
      try {
        if (sandbox) {
          // Dirt that reaches no input must not change what runs: the proof names the committed bytes.
          const visible = input.key === undefined ? dirty : [];
          selected = selection(task, tree, visible);
          const links = task.links ?? [];
          delivered = new Set(
            [...(task.delivered?.values() ?? [])]
              .flat()
              .filter(
                (path) =>
                  !selected.has(path) &&
                  !links.some((link) => path === link || path.startsWith(`${link}/`)),
              ),
          );
          sandbox.materialize(selected, tree, visible, staged, delivered);
          sandbox.link(links, inspection);
        }
      } catch (error) {
        // Unattended, the backstop finishes every task it can; a person running `run` is told now.
        if (!fresh) throw error;
        unbuilt = error instanceof Error ? error.message : String(error);
      }
      if (sandbox && !unbuilt) {
        const env: Record<string, string> = Object.create(null);
        for (const name of [...BASE_ENV, ...(task.env ?? [])]) {
          const value = process.env[name];
          if (value !== undefined) env[name] = value;
        }
        Object.assign(env, providers.environment(task.needs ?? [], slot));
        if (slot !== undefined) env.PROOF_LANE_SLOT = String(slot);
        const started = performance.now();
        const result = await processes.execute(
          task.run,
          sandbox.path,
          env,
          false,
          {
            project,
            kind: 'tasks',
            task: id,
            key: current.key,
            live,
          },
          task.timeout,
        );
        outcome = processes.cancelled
          ? 'incomplete'
          : result.budgetKilled
            ? 'red'
            : result.signal
              ? 'incomplete'
              : result.code === 0
                ? 'green'
                : 'red';
        seconds = (performance.now() - started) / 1000;
        const retained = result.capture?.finish(outcome) ?? {};
        if (retained.error) logFailed();
        log =
          (result.budgetKilled && !processes.cancelled
            ? `; killed at budget after ${task.timeout} seconds`
            : '') +
          (outcome === 'red' && retained.path
            ? notDelivered(retained.path, sandbox.root, tree, new Set([...selected, ...delivered]))
            : '') +
          logSuffix(retained);
      }
      if (outcome !== 'green') fail();
      const after = refresh();
      let unpublished = input.reason;
      if (!staged && !unpublished) {
        if (after.tree.commit !== baseline.tree.commit) unpublished = 'HEAD changed';
        else {
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
      return { outcome, notRecorded: current.key === undefined };
    } finally {
      try {
        sandbox?.close();
      } catch (error) {
        summary.push(
          `warning: sandbox cleanup failed for ${id}; left behind: ${sandbox?.path}; ${error}`,
        );
      }
    }
  } finally {
    lanes.release(lane, slot);
  }
}

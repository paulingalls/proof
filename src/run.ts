import { declarations, selectTasks } from './declarations';
import { RefTree, resolveRef } from './git';
import { Lanes } from './lanes';
import { currentTree, decide, renderDecision } from './plan';
import { Providers } from './providers';
import { RunProcesses } from './run-process';
import { runTask } from './run-task';
import { Store } from './store';

export const runUsage =
  'usage: proof run [--fresh | --staged] [--jobs N] [--tasks <id> ... | --set <name>]';

export async function run(args: string[]) {
  const fresh = args[0] === '--fresh';
  const staged = args[0] === '--staged';
  if (fresh || staged) args = args.slice(1);
  let jobs = 1;
  if (args[0] === '--jobs') {
    const value = args[1] ?? '';
    jobs = Number(value);
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(jobs)) throw new Error(runUsage);
    args = args.slice(2);
  }
  const set =
    args[0] === '--set' && args.length === 2 && !args[1]?.startsWith('-') ? args[1] : undefined;
  if (
    args.length &&
    set === undefined &&
    (args[0] !== '--tasks' || args.length < 2 || args.slice(1).some((id) => id.startsWith('--')))
  )
    throw new Error(runUsage);
  const parent = staged ? resolveRef('HEAD') : undefined;
  const captured = staged ? RefTree.index() : undefined;
  const snapshot = captured
    ? { tree: captured, ...declarations(captured), dirty: [], declaration: undefined }
    : undefined;
  let selected = snapshot ?? currentTree();
  const refresh = () => {
    selected = snapshot ?? currentTree();
    return selected;
  };
  const lanes = new Lanes(selected.lanes);
  const roster = selectTasks(selected.tasks, set);
  const requested = set === undefined ? args.slice(1) : [];
  for (const id of requested) if (!roster.has(id)) throw new Error(`undeclared task '${id}'`);
  const ids = [...roster.keys()].filter((id) => !requested.length || requested.includes(id));
  const store = await Store.open(selected.project);
  const summary: string[] = [];
  const skipped: string[] = [];
  let failed = false;
  let logFailed = false;
  const processes = new RunProcesses();
  const providers = new Providers(
    async (command, stopping, name, environment) => {
      const result = await processes.execute(
        command,
        process.cwd(),
        environment?.env ?? process.env,
        stopping,
        stopping
          ? undefined
          : {
              project: selected.project,
              kind: 'providers',
              task: name,
              live: jobs === 1,
            },
      );
      if (!stopping) {
        refresh();
      }
      const problem = result.code === 0 && !result.signal ? environment?.accept() : undefined;
      const ready = result.code === 0 && !result.signal && !problem;
      const log =
        result.capture?.finish(
          ready ? 'green' : processes.cancelled || result.signal ? 'incomplete' : 'red',
        ) ?? {};
      if (log.error) logFailed = true;
      return { ready, problem, ...log };
    },
    (message) => {
      failed = true;
      summary.push(message);
    },
    () => selected.tasks.values(),
    selected.providers,
  );
  const providerMismatches = new Map<string, string>();
  try {
    const preview = new Map<string, string>();
    const initial = selected;
    for (const id of ids) {
      const task = initial.tasks.get(id);
      if (!task) throw new Error(`undeclared task '${id}'`);
      const row = await decide(
        id,
        task,
        initial.tree,
        initial.dirty,
        initial.declaration,
        initial.project,
        store,
        undefined,
        fresh,
      );
      preview.set(id, renderDecision(row));
      console.log(renderDecision(row));
    }
    const unfinished = new Set(ids);
    const runningNeeds = new Map<string, Set<string>>();
    const summaries: string[][] = [];
    const pending = ids.map((id, index) => ({ index, id, lane: initial.tasks.get(id)?.lane }));
    const active = new Map<number, { lane?: string; done: Promise<void> }>();
    let fatal: { error: unknown } | undefined;
    async function execute(index: number, id: string, lane?: string) {
      const taskSummary: string[] = [];
      summaries[index] = taskSummary;
      try {
        await runTask(id, {
          lanes,
          lane,
          view: () => selected,
          refresh,
          skipped: (id) => skipped.push(id),
          fresh,
          live: jobs === 1,
          logFailed: () => {
            logFailed = true;
          },
          staged,
          parent,
          ids: [...unfinished],
          store,
          summary: jobs === 1 ? summary : taskSummary,
          preview,
          providerMismatches,
          processes,
          providers,
          retain: (needs) => {
            const retained = runningNeeds.get(id) ?? new Set<string>();
            for (const name of needs) retained.add(name);
            runningNeeds.set(id, retained);
          },
          fail: () => {
            failed = true;
          },
        });
        unfinished.delete(id);
        runningNeeds.delete(id);
        if (processes.aborted) return;
        const view = selected;
        await providers.stopExcept(
          new Set(
            [...unfinished].flatMap((later) => [
              ...(runningNeeds.get(later) ?? view.tasks.get(later)?.needs ?? []),
            ]),
          ),
        );
      } catch (error) {
        fatal ??= { error };
        processes.abort();
      }
    }
    while (pending.length || active.size) {
      while (
        pending.length &&
        active.size < jobs &&
        !processes.aborted &&
        ![...active.values()].some(({ lane }) => lane === 'solo') &&
        !(processes.interrupted && !providers.live())
      ) {
        const solo = pending.findIndex(({ lane }) => lane === 'solo');
        const next = pending.findIndex(({ lane }, index) => {
          if (solo >= 0 && index > solo) return false;
          if (lane === 'solo') return active.size === 0;
          return (
            lane === undefined ||
            [...active.values()].filter((entry) => entry.lane === lane).length <
              lanes.capacity(lane)
          );
        });
        if (next < 0) break;
        const entry = pending.splice(next, 1)[0] as (typeof pending)[number];
        const done = execute(entry.index, entry.id, entry.lane).finally(() =>
          active.delete(entry.index),
        );
        active.set(entry.index, { lane: entry.lane, done });
      }
      if (!active.size) break;
      await Promise.race([...active.values()].map((entry) => entry.done));
    }
    if (jobs > 1) summary.push(...summaries.flat());
    if (fatal) throw fatal.error;
    await store.skip(initial.project, skipped);
    await providers.stopExcept(new Set());
    console.log(summary.join('\n'));
    return processes.interrupted
      ? processes.interrupted === 'SIGINT'
        ? 130
        : 143
      : logFailed
        ? 2
        : failed
          ? 1
          : 0;
  } catch (error) {
    try {
      await providers.stopExcept(new Set());
      console.log(summary.join('\n'));
      await store.close();
    } catch {
      /* Preserve the command failure. */
    }
    throw error;
  } finally {
    processes.close();
    await store.close();
  }
}

import { declarationPaths, declarations, selectTasks } from './declarations';
import { ignoredPaths, RefTree, resolveRef } from './git';
import { scope } from './key';
import { currentTree, decide, renderDecision } from './plan';
import { Providers } from './providers';
import { RunProcesses } from './run-process';
import { runTask } from './run-task';
import { Store } from './store';

export async function run(args: string[]) {
  const fresh = args[0] === '--fresh';
  const staged = args[0] === '--staged';
  if (fresh || staged) args = args.slice(1);
  const usage =
    'usage: proof run [--fresh | --staged] [--jobs N] [--tasks <id> ... | --set <name>]';
  let jobs = 1;
  if (args[0] === '--jobs') {
    const value = args[1] ?? '';
    jobs = Number(value);
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(jobs)) throw new Error(usage);
    args = args.slice(2);
  }
  const set =
    args[0] === '--set' && args.length === 2 && !args[1]?.startsWith('-') ? args[1] : undefined;
  if (
    args.length &&
    set === undefined &&
    (args[0] !== '--tasks' || args.length < 2 || args.slice(1).some((id) => id.startsWith('--')))
  )
    throw new Error(usage);
  const parent = staged ? resolveRef('HEAD') : undefined;
  const captured = staged ? RefTree.index() : undefined;
  const snapshot = captured
    ? { tree: captured, ...declarations(captured), dirty: [], declaration: undefined }
    : undefined;
  const inventories = new Map<string, string[]>();
  const inventory = (tree: RefTree, document: ReturnType<typeof declarations>) => {
    const identity = JSON.stringify([
      tree.commit,
      document.include,
      [...document.tasks.values()].map((task) => task.inputs),
    ]);
    let paths = inventories.get(identity);
    if (!paths) {
      paths = ignoredPaths(
        scope(document.tasks.values(), declarationPaths(document.include), tree),
      );
      inventories.set(identity, paths);
    }
    return paths;
  };
  let selected = snapshot ?? currentTree(inventory);
  const refresh = () => {
    selected = snapshot ?? currentTree(inventory);
    return selected;
  };
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
        inventories.clear();
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
    const slots: string[][] = [];
    const pending = ids.map((id, index) => ({ index, id, lane: initial.tasks.get(id)?.lane }));
    const active = new Map<number, { lane?: string; done: Promise<void> }>();
    let fatal: { error: unknown } | undefined;
    async function execute(index: number, id: string) {
      const taskSummary: string[] = [];
      slots[index] = taskSummary;
      try {
        await runTask(id, {
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
              (initial.lanes.get(lane) as number)
          );
        });
        if (next < 0) break;
        const entry = pending.splice(next, 1)[0] as (typeof pending)[number];
        const done = execute(entry.index, entry.id).finally(() => active.delete(entry.index));
        active.set(entry.index, { lane: entry.lane, done });
      }
      if (!active.size) break;
      await Promise.race([...active.values()].map((entry) => entry.done));
    }
    if (jobs > 1) summary.push(...slots.flat());
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

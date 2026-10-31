import { declarations, selectTasks } from './declarations';
import { RefTree, resolveRef } from './git';
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
  const roster = selectTasks((snapshot ?? currentTree()).tasks, set);
  const requested = set === undefined ? args.slice(1) : [];
  for (const id of requested) if (!roster.has(id)) throw new Error(`undeclared task '${id}'`);
  const ids = [...roster.keys()].filter((id) => !requested.length || requested.includes(id));
  const store = await Store.open();
  const summary: string[] = [];
  let failed = false;
  const processes = new RunProcesses();
  const providers = new Providers(
    async (command, stopping = false) => {
      const result = await processes.execute(command, process.cwd(), process.env, stopping);
      return result.code === 0 && !result.signal;
    },
    (message) => {
      failed = true;
      summary.push(message);
    },
  );
  const providerMismatches = new Map<string, string>();
  try {
    const preview = new Map<string, string>();
    const initial = snapshot ?? currentTree();
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
          snapshot,
          fresh,
          capture: jobs > 1,
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
        const view = snapshot ?? currentTree();
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
        !(processes.interrupted && !providers.live())
      ) {
        const next = pending.findIndex(
          ({ lane }) =>
            lane === undefined ||
            lane === 'solo' ||
            [...active.values()].filter((entry) => entry.lane === lane).length <
              (initial.lanes.get(lane) as number),
        );
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
    await providers.stopExcept(new Set());
    console.log(summary.join('\n'));
    return processes.interrupted
      ? processes.interrupted === 'SIGINT'
        ? 130
        : 143
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

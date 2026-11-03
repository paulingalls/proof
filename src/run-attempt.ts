import type { Task } from './declarations';
import type { RefTree } from './git';
import { selection } from './key';
import { logSuffix, notDelivered, omittedPaths } from './logs';
import { BASE_ENV, type Providers } from './providers';
import type { RunProcesses } from './run-process';
import type { inspectLinks, Sandbox } from './sandbox';

type Context = {
  id: string;
  task: Task;
  tree: RefTree;
  visible: string[];
  strict: boolean;
  sandbox?: Sandbox;
  inspection: ReturnType<typeof inspectLinks>;
  fresh: boolean;
  staged: boolean;
  providers: Providers;
  slot?: number;
  processes: RunProcesses;
  project: string;
  key?: string;
  live: boolean;
  logFailed: () => void;
};

export async function runAttempt({
  id,
  task,
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
  key,
  live,
  logFailed,
}: Context) {
  let seconds: number | null = null;
  let outcome: 'incomplete' | 'green' | 'red' = 'incomplete';
  let unbuilt: string | undefined;
  let log = '';
  let omitted: string[] = [];
  let selected = new Set<string>();
  let delivered = new Set<string>();
  let delivery = new Set<string>();
  try {
    if (sandbox) {
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
      delivery = strict ? new Set() : delivered;
      sandbox.materialize(selected, tree, visible, staged, delivery);
      sandbox.link(task.links ?? [], inspection);
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
      { project, kind: 'tasks', task: id, key, live },
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
    if (outcome === 'red' && retained.path)
      omitted = omittedPaths(
        retained.path,
        sandbox.root,
        tree,
        new Set([...selected, ...delivery]),
      );
    log =
      (result.budgetKilled && !processes.cancelled
        ? `; killed at budget after ${task.timeout} seconds`
        : '') +
      notDelivered(omitted) +
      logSuffix(retained);
  }
  return { outcome, seconds, unbuilt, log, omitted, delivered };
}

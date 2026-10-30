import { hostname } from 'node:os';
import { declarationPaths } from './declarations';
import { dirtyPaths, RefTree } from './git';
import { key, scope, selection } from './key';
import { currentTree, decide } from './plan';
import { inspectLinks, Sandbox } from './sandbox';
import { Store } from './store';

function signalGroup(pid: number, signal: NodeJS.Signals | 0) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return false;
  }
}

export async function run(args: string[]) {
  if (
    args.length &&
    (args[0] !== '--tasks' || args.length < 2 || args.slice(1).some((id) => id.startsWith('--')))
  )
    throw new Error('usage: proof run [--tasks <id> ...]');
  const roster = currentTree().tasks;
  for (const id of args.slice(1)) if (!roster.has(id)) throw new Error(`undeclared task '${id}'`);
  const ids = [...roster.keys()].filter((id) => !args.length || args.slice(1).includes(id));
  const store = new Store();
  const summary: string[] = [];
  let failed = false;
  let interrupted: 'SIGINT' | 'SIGTERM' | undefined;
  let active: ReturnType<typeof Bun.spawn> | undefined;
  const interrupt = (signal: 'SIGINT' | 'SIGTERM') => {
    // A shell's `&` jobs start with SIGINT ignored, so a second interrupt must be able to end them.
    if (interrupted) {
      if (active) signalGroup(active.pid, 'SIGKILL');
      return;
    }
    interrupted = signal;
    if (active) signalGroup(active.pid, signal);
  };
  const onInt = () => interrupt('SIGINT');
  const onTerm = () => interrupt('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  try {
    for (const id of ids) {
      if (interrupted) break;
      const { tree, project, tasks, include, dirty, declaration } = currentTree();
      const task = tasks.get(id);
      if (!task) throw new Error(`undeclared task '${id}'`);
      const inspection = inspectLinks(task.links ?? [], tree.files.keys());
      const decision = decide(id, task, tree, dirty, declaration, project, store, inspection);
      console.log(`${decision.state} ${id}: ${decision.reason}`);
      if (decision.state === 'PROVEN') {
        summary.push(`PROVEN ${id}: ${decision.reason}`);
        continue;
      }
      const current = declaration
        ? { reason: `dirty declaration '${declaration}'`, key: undefined }
        : key(id, task, tree);
      const sandbox = new Sandbox();
      try {
        sandbox.materialize(selection(task, tree, dirty), tree, dirty);
        sandbox.link(task.links ?? []);
        const env: Record<string, string> = {};
        for (const name of ['PATH', 'HOME', 'TMPDIR', ...(task.env ?? [])]) {
          const value = process.env[name];
          if (value !== undefined) env[name] = value;
        }
        const started = performance.now();
        const child = Bun.spawn(['sh', '-c', task.run], {
          detached: true,
          cwd: sandbox.path,
          env,
          stdout: 'inherit',
          stderr: 'inherit',
        });
        active = child;
        const code = await child.exited;
        // A shell may exit before its foreground child has finished handling the signal.
        if (interrupted) while (signalGroup(child.pid, 0)) await Bun.sleep(10);
        active = undefined;
        const outcome =
          interrupted || child.signalCode ? 'incomplete' : code === 0 ? 'green' : 'red';
        const seconds = (performance.now() - started) / 1000;
        failed ||= outcome !== 'green';
        let unpublished = dirty.length ? `dirty path '${dirty[0]}'` : undefined;
        if (!unpublished) {
          if (new RefTree('HEAD').commit !== tree.commit) unpublished = 'HEAD changed';
          else {
            const changed = sandbox.changed();
            const added = dirtyPaths(scope(tasks.values(), declarationPaths(include))).find(
              (path) => !dirty.includes(path),
            );
            if (changed) unpublished = `selected path changed '${changed}'`;
            else if (added) unpublished = `new dirty path '${added}'`;
          }
        }
        const escapes = [
          ...new Set([
            ...inspection.escapes,
            ...inspectLinks(task.links ?? [], tree.files.keys()).escapes,
          ]),
        ];
        if (escapes.length) unpublished = [unpublished, ...escapes].filter(Boolean).join('; ');
        if (current.key !== undefined) {
          store.record(
            project,
            id,
            current.key,
            outcome,
            seconds,
            hostname(),
            tree.commit,
            unpublished !== undefined,
            key(id, task, tree, dirty).key === undefined,
          );
          summary.push(
            `${outcome} ${id}${unpublished ? `; no proof published: ${unpublished}` : outcome === 'green' ? '; proof published' : ''}`,
          );
        } else
          summary.push(
            `${outcome} ${id}; not recorded: ${current.reason}${escapes.length ? `; ${escapes.join('; ')}` : ''}`,
          );
      } finally {
        sandbox.close();
      }
    }
    console.log(summary.join('\n'));
    return interrupted ? (interrupted === 'SIGINT' ? 130 : 143) : failed ? 1 : 0;
  } finally {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    store.close();
  }
}

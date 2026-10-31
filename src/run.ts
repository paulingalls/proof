import { hostname } from 'node:os';
import { declarationPaths } from './declarations';
import { dirtyPaths, resolveRef } from './git';
import { key, scope, selection } from './key';
import { currentTree, decide, inspectTaskLinks, renderDecision } from './plan';
import { Providers } from './providers';
import { Sandbox } from './sandbox';
import { Store } from './store';

function signalGroup(pid: number, signal: NodeJS.Signals | 0) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // macOS answers EPERM while the group's only members are zombies awaiting their reaper.
    if (code === 'EPERM') return true;
    if (code !== 'ESRCH') throw error;
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
  const store = await Store.open();
  const summary: string[] = [];
  let failed = false;
  let interrupted: 'SIGINT' | 'SIGTERM' | undefined;
  let active: ReturnType<typeof Bun.spawn> | undefined;
  let cleanup = false;
  const interrupt = (signal: 'SIGINT' | 'SIGTERM') => {
    // A shell's `&` jobs start with SIGINT ignored, so a second interrupt must be able to end them.
    if (interrupted) {
      if (active) signalGroup(active.pid, 'SIGKILL');
      return;
    }
    interrupted = signal;
    if (active && !cleanup) signalGroup(active.pid, signal);
  };
  const onInt = () => interrupt('SIGINT');
  const onTerm = () => interrupt('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  async function execute(command: string, cwd: string, env = process.env, stopping = false) {
    cleanup = stopping;
    const child = Bun.spawn(['sh', '-c', command], {
      detached: true,
      cwd,
      env,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    active = child;
    try {
      const code = await child.exited;
      // A shell may exit before its foreground child has finished handling the signal.
      if (interrupted && !stopping) while (signalGroup(child.pid, 0)) await Bun.sleep(10);
      return { code, signal: child.signalCode };
    } finally {
      active = undefined;
      cleanup = false;
    }
  }
  const providers = new Providers(
    async (command, stopping = false) => {
      const result = await execute(command, process.cwd(), process.env, stopping);
      return result.code === 0 && !result.signal;
    },
    (message) => {
      failed = true;
      summary.push(message);
    },
  );
  try {
    const preview = new Map<string, string>();
    const initial = currentTree();
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
      );
      preview.set(id, renderDecision(row));
      console.log(renderDecision(row));
    }
    for (const [index, id] of ids.entries()) {
      if (interrupted && !providers.live()) break;
      const baseline = currentTree();
      let view = baseline;
      let task = view.tasks.get(id);
      if (!task) throw new Error(`undeclared task '${id}'`);
      if (interrupted && !providers.attempted(task.needs ?? [])) continue;
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
      );
      if (interrupted && !providers.attempted(task.needs ?? [])) continue;
      const printRevision = () => {
        const rendered = renderDecision(decision);
        if (preview.get(id) !== rendered) console.log(rendered);
        preview.set(id, rendered);
      };
      printRevision();
      let started = false;
      if (decision.state !== 'PROVEN' && !interrupted) {
        for (const name of task.needs ?? []) {
          if (interrupted) break;
          const provider = view.providers.get(name);
          if (!provider) throw new Error(`unknown provider '${name}'`);
          started ||= !providers.attempted([name]);
          await providers.start(name, provider);
        }
      }
      if (started) {
        view = currentTree();
        task = view.tasks.get(id);
        if (!task) throw new Error(`undeclared task '${id}'`);
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
        );
        printRevision();
      }
      const { tree, project, dirty, declaration } = view;
      const release = () =>
        providers.stopExcept(
          new Set(ids.slice(index + 1).flatMap((later) => view.tasks.get(later)?.needs ?? [])),
        );
      if (decision.state === 'PROVEN') {
        summary.push(`PROVEN ${id}: ${decision.reason}`);
        await release();
        continue;
      }
      const blocked =
        interrupted ||
        (task.needs ?? []).map((name) => providers.ready(name)).some((ready) => !ready);
      const current = declaration
        ? { reason: `dirty declaration '${declaration}'`, key: undefined }
        : key(id, task, tree);
      const sandbox = blocked ? undefined : new Sandbox();
      try {
        let seconds: number | null = null;
        let outcome: 'incomplete' | 'green' | 'red' = 'incomplete';
        if (sandbox) {
          sandbox.materialize(selection(task, tree, dirty), tree, dirty);
          sandbox.link(task.links ?? [], inspection);
          const env: Record<string, string> = {};
          for (const name of ['PATH', 'HOME', 'TMPDIR', ...(task.env ?? [])]) {
            const value = process.env[name];
            if (value !== undefined) env[name] = value;
          }
          const started = performance.now();
          const result = await execute(task.run, sandbox.path, env);
          outcome =
            interrupted || result.signal ? 'incomplete' : result.code === 0 ? 'green' : 'red';
          seconds = (performance.now() - started) / 1000;
        }
        failed ||= outcome !== 'green';
        let unpublished = baseline.dirty.length ? `dirty path '${baseline.dirty[0]}'` : undefined;
        if (!unpublished) {
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
          const sharing = await store.record(
            project,
            id,
            current.key,
            outcome,
            seconds,
            hostname(),
            tree.commit,
            unpublished !== undefined,
            key(id, task, tree, afterDirty).key === undefined,
            current.env,
          );
          summary.push(
            `${outcome} ${id}${unpublished ? `; no proof published: ${unpublished}` : outcome === 'green' ? '; proof published' : ''}${sharing === 'local' ? '' : `; ${sharing}`}`,
          );
        } else
          summary.push(
            `${outcome} ${id}; not recorded: ${current.reason}${escapes.length ? `; ${escapes.join('; ')}` : ''}`,
          );
      } finally {
        sandbox?.close();
      }
      await release();
    }
    await providers.stopExcept(new Set());
    console.log(summary.join('\n'));
    return interrupted ? (interrupted === 'SIGINT' ? 130 : 143) : failed ? 1 : 0;
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
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    await store.close();
  }
}

import { hostname } from 'node:os';
import { declarationPaths } from './declarations';
import { dirtyPaths, RefTree } from './git';
import { key, scope, selection } from './key';
import { currentTree, decide } from './plan';
import { Sandbox } from './sandbox';
import { Store } from './store';

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
  let red = false;
  try {
    for (const id of ids) {
      const { tree, project, tasks, include, dirty, declaration } = currentTree();
      const task = tasks.get(id);
      if (!task) throw new Error(`undeclared task '${id}'`);
      const decision = decide(id, task, tree, dirty, declaration, project, store);
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
        const env: Record<string, string> = {};
        for (const name of ['PATH', 'HOME', 'TMPDIR', ...(task.env ?? [])]) {
          const value = process.env[name];
          if (value !== undefined) env[name] = value;
        }
        const started = performance.now();
        const child = Bun.spawn(['sh', '-c', task.run], {
          cwd: sandbox.path,
          env,
          stdout: 'inherit',
          stderr: 'inherit',
        });
        const outcome = (await child.exited) === 0 ? 'green' : 'red';
        const seconds = (performance.now() - started) / 1000;
        red ||= outcome === 'red';
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
        } else summary.push(`${outcome} ${id}; not recorded: ${current.reason}`);
      } finally {
        sandbox.close();
      }
    }
    console.log(summary.join('\n'));
    return red ? 1 : 0;
  } finally {
    store.close();
  }
}

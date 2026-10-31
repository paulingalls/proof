import { hostname } from 'node:os';
import { declarations } from './declarations';
import { RefTree } from './git';
import { key } from './key';
import { Store } from './store';

export async function invalidate(args: string[]) {
  const usage = 'usage: proof invalidate --task <t> [--key k | --all]';
  let id: string | undefined;
  let selected: string | undefined;
  let all = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--all' && !all) all = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error(usage);
      if (flag === '--task' && id === undefined) id = value;
      else if (flag === '--key' && selected === undefined) selected = value;
      else throw new Error(usage);
    }
  }
  if (!id || (all && selected !== undefined)) throw new Error(usage);
  const tree = new RefTree('HEAD');
  const { project, tasks } = declarations(tree);
  if (!all && selected === undefined) {
    const task = tasks.get(id);
    if (!task) throw new Error(`undeclared task '${id}'`);
    const current = key(id, task, tree);
    if (current.key === undefined) throw new Error(`undecidable: ${current.reason}`);
    selected = current.key;
  }
  const store = await Store.open(project);
  try {
    const result = await store.invalidate(project, id, selected, hostname(), tree.commit);
    return result.shared === undefined
      ? `deleted ${result.local} proof(s)`
      : `deleted ${result.local} local proof(s); deleted ${result.shared} shared proof(s)`;
  } catch (error) {
    try {
      await store.close();
    } catch {
      /* Preserve the command failure. */
    }
    throw error;
  } finally {
    await store.close();
  }
}

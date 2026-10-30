import { hostname } from 'node:os';
import { declarations } from './declarations';
import { RefTree } from './git';
import { key } from './key';
import { Store } from './store';

export function record(args: string[]) {
  const [id, ...flags] = args;
  const usage = 'usage: proof record <task> --outcome green [--seconds N]';
  if (!id || id.startsWith('--')) throw new Error(usage);
  let outcome: string | undefined;
  let seconds: number | null = null;
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i];
    const value = flags[i + 1];
    if (value === undefined) throw new Error(usage);
    if (flag === '--outcome' && outcome === undefined) outcome = value;
    else if (flag === '--seconds' && seconds === null) {
      seconds = Number(value);
      if (!value.trim() || !Number.isFinite(seconds) || seconds < 0)
        throw new Error('--seconds must be a finite nonnegative number');
    } else throw new Error(usage);
  }
  if (outcome !== 'green') throw new Error('--outcome green is required');
  const tree = new RefTree('HEAD');
  const { project, tasks } = declarations(tree);
  const task = tasks.get(id);
  if (!task) throw new Error(`undeclared task '${id}'`);
  const current = key(id, task, tree);
  if (current.key === undefined) throw new Error(`undecidable: ${current.reason}`);
  const store = new Store();
  try {
    store.record(project, id, current.key, seconds, hostname(), tree.commit, false);
    return `recorded green ${id}; proof published`;
  } finally {
    store.close();
  }
}

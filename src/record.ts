import { hostname } from 'node:os';
import { declarations, dirtyDeclaration } from './declarations';
import { dirtyPaths, RefTree } from './git';
import { key } from './key';
import { Store } from './store';

export const recordUsage =
  'usage: proof record <task> --outcome green|red|incomplete [--seconds N]';

export async function record(args: string[]) {
  const [id, ...flags] = args;
  if (!id || id.startsWith('--')) throw new Error(recordUsage);
  let outcome: string | undefined;
  let seconds: number | null = null;
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i];
    const value = flags[i + 1];
    if (value === undefined) throw new Error(recordUsage);
    if (flag === '--outcome' && outcome === undefined) outcome = value;
    else if (flag === '--seconds' && seconds === null) {
      seconds = Number(value);
      if (!value.trim() || !Number.isFinite(seconds) || seconds < 0)
        throw new Error('--seconds must be a finite nonnegative number');
    } else throw new Error(recordUsage);
  }
  if (outcome === undefined) throw new Error(recordUsage);
  if (outcome !== 'green' && outcome !== 'red' && outcome !== 'incomplete')
    throw new Error(`unknown outcome '${outcome}'`);
  const tree = new RefTree('HEAD');
  const { project, tasks, include } = declarations(tree);
  const task = tasks.get(id);
  if (!task) throw new Error(`undeclared task '${id}'`);
  const current = key(id, task, tree);
  if (current.key === undefined) throw new Error(`undecidable: ${current.reason}`);
  const dirty = dirtyPaths();
  // A red about other bytes (a dirty input or declaration) says nothing about this key.
  const declaration = dirtyDeclaration(dirty, include);
  const otherBytes =
    outcome === 'red'
      ? declaration
        ? `dirty declaration '${declaration}'`
        : key(id, task, tree, dirty).reason
      : undefined;
  const store = await Store.open(project);
  try {
    const { sharing } = await store.record(
      project,
      id,
      current.key,
      outcome,
      seconds,
      hostname(),
      tree.commit,
      dirty.length > 0,
      otherBytes !== undefined,
      current.env,
      current.dimensionValues,
    );
    const suffix = sharing === 'local' ? '' : `; ${sharing}`;
    if (otherBytes) return `recorded red ${id}; contests nothing: ${otherBytes}${suffix}`;
    if (outcome !== 'green') return `recorded ${outcome} ${id}${suffix}`;
    return dirty.length
      ? `recorded green ${id}; no proof published: dirty path '${dirty[0]}'${suffix}`
      : `recorded green ${id}; proof published${suffix}`;
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

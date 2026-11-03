import { existsSync } from 'node:fs';
import { type Task, text } from './declarations';
import { dirtyPaths, type RefTree } from './git';
import { selection } from './key';

export function filePatterns(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${context}: expected a list`);
  return value.map((entry) => {
    const pattern = text(entry, context);
    if (pattern.startsWith('!'))
      throw new Error(`${context}: negation '${pattern}' is not allowed`);
    return pattern;
  });
}

export function resolveUnkeyed(
  value: unknown,
  superOnly: unknown,
  tasks: Map<string, Task>,
  tree: RefTree,
  working: boolean,
) {
  const context = `ref '${tree.ref}' proof.yaml`;
  const patterns = filePatterns(value, `${context} unkeyed`);
  const superPatterns = filePatterns(superOnly, `${context} super-only`);
  const entries = [
    ...patterns,
    ...superPatterns,
    ...[...tasks.values()].flatMap((task) => task.keyed ?? []),
  ];
  if (!entries.length) return;
  const dirty = working ? dirtyPaths() : [];
  const available = [...new Set([...tree.files.keys(), ...dirty])].filter(
    (path) => !working || existsSync(path),
  );
  const present = new Set(available);
  function matches(pattern: string, label: string) {
    // A generated list holds hundreds of literal paths; one scan of the tree each would dominate plan.
    if (present.has(pattern)) return [pattern];
    const glob = new Bun.Glob(pattern);
    const paths = available.filter((path) => glob.match(path));
    if (!paths.length) throw new Error(`${context} ${label}: unmatched '${pattern}'`);
    return paths;
  }
  const omitted = new Set(patterns.flatMap((pattern) => matches(pattern, 'unkeyed')));
  const superPaths = new Set(superPatterns.flatMap((pattern) => matches(pattern, 'super-only')));
  for (const path of superPaths)
    if (omitted.has(path)) throw new Error(`${context} super-only: '${path}' is also unkeyed`);
  const covered = new Set<string>();
  for (const [id, task] of tasks) {
    const keyed = new Set(
      (task.keyed ?? []).flatMap((pattern) => matches(pattern, `task '${id}' keyed`)),
    );
    const received = keyed.size ? selection(task, tree, dirty) : new Set<string>();
    for (const path of keyed) {
      if (superPaths.has(path))
        throw new Error(`${context} task '${id}' keyed: '${path}' is super-only`);
      if (!omitted.has(path))
        throw new Error(`${context} task '${id}' keyed: '${path}' is outside unkeyed`);
      if (received.has(path)) covered.add(path);
    }
    task.unkeyed = new Set([...omitted, ...superPaths].filter((path) => !keyed.has(path)));
    task.superOnly = superPaths;
  }
  for (const path of omitted)
    if (!covered.has(path))
      throw new Error(`${context} unkeyed: '${path}' has no keyed representative receiving it`);
}

export function resolveDelivered(patterns: string[], tree: RefTree) {
  const delivered = new Map<string, string[]>();
  for (const pattern of new Set(patterns)) {
    const glob = new Bun.Glob(pattern);
    const paths = tree.files.has(pattern)
      ? [pattern]
      : [...tree.files.keys()].filter((path) => glob.match(path));
    if (!paths.length)
      throw new Error(`ref '${tree.ref}' proof.yaml delivered: unmatched '${pattern}'`);
    delivered.set(pattern, paths);
  }
  return delivered;
}

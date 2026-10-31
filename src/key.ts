import type { Task } from './declarations';
import type { RefTree, Scope } from './git';
import { closure, source } from './imports';
import { keyParts } from './key-parts';
import { maestro } from './maestro';

type Key =
  | { key: string; env: [string, string][]; reason?: never }
  | { key?: never; reason: string };

const inventories = new WeakMap<RefTree, string[]>();

function inventory(tree: RefTree) {
  let paths = inventories.get(tree);
  if (!paths) {
    paths = [...tree.files.keys()].sort();
    inventories.set(tree, paths);
  }
  return paths;
}

function* candidates(available: string[], pattern: string, dirty: string[]) {
  const start = literalDirectory(pattern);
  let low = 0;
  let high = available.length;
  if (start !== undefined) {
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if ((available[mid] as string) < start) low = mid + 1;
      else high = mid;
    }
  }
  for (let i = low; i < available.length; i++) {
    const path = available[i] as string;
    if (start !== undefined && !path.startsWith(start)) break;
    yield path;
  }
  yield* dirty;
}

export function select(
  task: Task,
  tree: RefTree,
  dirty: string[] = [],
  working = false,
  available = inventory(tree),
) {
  const view = source(tree, working ? dirty : undefined);
  const paths = new Set<string>();
  const manifests = new Set<string>();
  const whole = new Set<string>();
  let reason: string | undefined;
  for (const pattern of task.inputs) {
    if (typeof pattern !== 'string') {
      if ('imports-of' in pattern) {
        const found = closure(pattern['imports-of'], view);
        for (const path of found.paths) paths.add(path);
        for (const path of found.whole) whole.add(path);
        for (const path of found.manifests) manifests.add(path);
        reason ??= found.reason;
      }
      if ('maestro' in pattern) {
        const found = maestro(pattern.maestro, view);
        for (const path of found.paths) whole.add(path);
        for (const path of found.paths) paths.add(path);
        reason ??= found.reason;
      }
      continue;
    }
    const negative = pattern.startsWith('!');
    const positive = negative ? pattern.slice(1) : pattern;
    const glob = new Bun.Glob(positive);
    let matched = false;
    for (const path of candidates(available, positive, negative ? [...dirty, ...paths] : dirty)) {
      if (glob.match(path)) {
        matched = true;
        if (negative) {
          paths.delete(path);
          whole.delete(path);
        } else {
          paths.add(path);
          whole.add(path);
        }
      }
    }
    if (!matched) reason ??= `unmatched input '${pattern}'`;
  }
  return {
    paths,
    manifests: [...manifests].filter((path) => paths.has(path) && !whole.has(path)),
    reason,
  };
}

export function selection(task: Task, tree: RefTree, dirty: string[] = []) {
  // A clean tree publishes under the committed key: an ignored file must not win resolution.
  const selected = select(task, tree, dirty, dirty.length > 0);
  return new Set([
    ...selected.paths,
    ...task.inputs.flatMap((input) =>
      typeof input !== 'string' && 'path' in input ? [input.path] : [],
    ),
  ]);
}

export function* matching(tree: RefTree, pattern: string) {
  const glob = new Bun.Glob(pattern);
  for (const path of candidates(inventory(tree), pattern, [])) {
    if (glob.match(path)) yield path;
  }
}

export function selects(task: Task, path: string, tree: RefTree) {
  return (
    select(task, tree, [path], false, []).paths.has(path) ||
    task.inputs.some((input) => typeof input !== 'string' && 'path' in input && input.path === path)
  );
}

function literalDirectory(pattern: string) {
  const glob = pattern.search(/[(!*?[{\\]/);
  if (glob === -1) return pattern;
  return pattern.slice(0, pattern.lastIndexOf('/', glob) + 1) || undefined;
}

export function scope(tasks: Iterable<Task>, declarations: string[], tree: RefTree): Scope {
  const list = [...tasks];
  const patterns = [...declarations, ...list.flatMap((t) => t.inputs)].filter(
    (p): p is string => typeof p === 'string' && !p.startsWith('!'),
  );
  const prefixes = [
    ...patterns.map(literalDirectory),
    ...list.flatMap((t) =>
      t.inputs.flatMap((input) =>
        typeof input !== 'string' && 'path' in input ? [input.path] : [],
      ),
    ),
  ];
  return {
    selects: (path) =>
      declarations.some((d) => new Bun.Glob(d).match(path)) ||
      list.some((t) => selects(t, path, tree)),
    prefixes: prefixes.includes(undefined) ? undefined : [...new Set(prefixes as string[])],
  };
}

export function key(id: string, task: Task, tree: RefTree, dirty: string[] = []): Key {
  if (dirty.length) {
    const selection = select(task, tree, dirty);
    const path = dirty.find(
      (path) =>
        selection.paths.has(path) ||
        task.inputs.some(
          (input) => typeof input !== 'string' && 'path' in input && input.path === path,
        ),
    );
    if (path && !selection.reason) return { reason: `dirty input '${path}'` };
    if (
      !selection.reason &&
      dirty.some(
        (path) =>
          !tree.files.has(path) || path === 'package.json' || path.endsWith('/package.json'),
      )
    ) {
      try {
        const working = select(task, tree, dirty, true);
        const added = dirty.find((path) => working.paths.has(path));
        if (added) return { reason: `dirty input '${added}'` };
        if (working.reason) return { reason: working.reason };
      } catch (error) {
        return { reason: `working inputs: ${error}` };
      }
    }
  }
  const parts = keyParts(task, tree);
  if (parts.reasons.length) return { reason: parts.reasons[0] as string };
  const tuple: unknown[] = [2, id, parts.declaration, [...parts.files, ...parts.members]];
  if (task.env?.length) tuple.push(parts.env.map(([name, hash]) => ['env', name, hash]));
  const hash = new Bun.CryptoHasher('sha256').update(JSON.stringify(tuple)).digest('hex');
  return { key: hash, env: parts.env };
}

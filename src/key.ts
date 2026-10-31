import type { Task } from './declarations';
import { type RefTree, type Scope, WorkingTree } from './git';
import { closure, source } from './imports';
import { keyParts } from './key-parts';
import { maestro } from './maestro';

type Key =
  | { key: string; env: [string, string][]; reason?: never }
  | { key?: never; reason: string };

const inventories = new WeakMap<RefTree, string[]>();

function inventory(tree: RefTree) {
  if (tree instanceof WorkingTree) return [...tree.files.keys()].sort();
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

export function select(task: Task, tree: RefTree, dirty: string[] = [], working = false) {
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
    for (const path of [
      ...matching(tree, positive),
      ...(negative ? [...dirty, ...paths] : dirty).filter((path) => glob.match(path)),
    ]) {
      matched = true;
      if (negative) {
        paths.delete(path);
        whole.delete(path);
      } else {
        paths.add(path);
        whole.add(path);
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

const matches = new WeakMap<RefTree, Map<string, string[]>>();
export function* matching(tree: RefTree, pattern: string) {
  let cached = matches.get(tree);
  if (!cached) {
    cached = new Map();
    if (!(tree instanceof WorkingTree)) matches.set(tree, cached);
  }
  let paths = cached.get(pattern);
  if (!paths) {
    const glob = new Bun.Glob(pattern);
    paths = [...candidates(inventory(tree), pattern, [])].filter((path) => glob.match(path));
    cached.set(pattern, paths);
  }
  yield* paths;
}

const selectors = new WeakMap<RefTree, WeakMap<Task, (path: string) => boolean>>();

function selector(task: Task, tree: RefTree) {
  let cached = selectors.get(tree);
  if (!cached) {
    cached = new WeakMap();
    selectors.set(tree, cached);
  }
  const prior = cached.get(task);
  if (prior) return prior;
  const view = source(tree);
  const rules = task.inputs.map((input) => {
    if (typeof input === 'string') {
      const negative = input.startsWith('!');
      return { negative, glob: new Bun.Glob(negative ? input.slice(1) : input) };
    }
    return {
      paths:
        'imports-of' in input
          ? closure(input['imports-of'], view).paths
          : 'maestro' in input
            ? maestro(input.maestro, view).paths
            : new Set('path' in input ? [input.path] : []),
      projection: 'path' in input,
    };
  });
  const matches = (path: string) => {
    let selected = false;
    let projected = false;
    for (const rule of rules) {
      if (rule.glob) {
        if (rule.glob.match(path)) selected = !rule.negative;
      } else if (rule.paths.has(path)) {
        if (rule.projection) projected = true;
        else selected = true;
      }
    }
    return selected || projected;
  };
  cached.set(task, matches);
  return matches;
}

export function selects(task: Task, path: string, tree: RefTree) {
  return selector(task, tree)(path);
}

function literalDirectory(pattern: string) {
  const glob = pattern.search(/[(!*?[{\\]/);
  if (glob === -1) return pattern;
  return pattern.slice(0, pattern.lastIndexOf('/', glob) + 1) || undefined;
}

export function scope(tasks: Iterable<Task>, declarations: string[], tree: RefTree): Scope {
  const list = [...tasks];
  const matchers = list.map((task) => {
    let matches: ReturnType<typeof selector> | undefined;
    return (path: string) => {
      matches ??= selector(task, tree);
      return matches(path);
    };
  });
  const patterns = [...declarations, ...list.flatMap((t) => t.inputs)].filter(
    (p): p is string => typeof p === 'string' && !p.startsWith('!'),
  );
  const positive = [...new Set(patterns)].map((pattern) => new Bun.Glob(pattern));
  const declared = declarations.map((pattern) => new Bun.Glob(pattern));
  let derived: Set<string> | undefined;
  function closurePaths() {
    if (derived) return derived;
    derived = new Set<string>();
    const view = source(tree);
    for (const task of list)
      for (const input of task.inputs) {
        if (typeof input === 'string') continue;
        const paths =
          'imports-of' in input
            ? closure(input['imports-of'], view).paths
            : 'maestro' in input
              ? maestro(input.maestro, view).paths
              : 'path' in input
                ? [input.path]
                : [];
        for (const path of paths) derived.add(path);
      }
    return derived;
  }
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
      declared.some((glob) => glob.match(path)) ||
      ((positive.some((glob) => glob.match(path)) || closurePaths().has(path)) &&
        matchers.some((matches) => matches(path))),
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
  const tuple: unknown[] = [4, id, parts.declaration, [...parts.files, ...parts.members]];
  if (parts.env.length) tuple.push(parts.env.map(([name, hash]) => ['env', name, hash]));
  const hash = new Bun.CryptoHasher('sha256').update(JSON.stringify(tuple)).digest('hex');
  return { key: hash, env: parts.env };
}

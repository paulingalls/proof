import type { Input, Task } from './declarations';
import type { RefTree, Scope } from './git';
import { closure, source } from './imports';

type Key = { key: string; reason?: never } | { key?: never; reason: string };

const contents = new WeakMap<RefTree, Map<string, string>>();
const inventories = new WeakMap<RefTree, string[]>();

function inventory(tree: RefTree) {
  let paths = inventories.get(tree);
  if (!paths) {
    paths = [...tree.files.keys()].sort();
    inventories.set(tree, paths);
  }
  return paths;
}

function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([name, member]) => [JSON.stringify(name), canonical(member)] as const)
      .sort(([a], [b]) => compare(a, b))
      .map(([name, member]) => `${name}:${member}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
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

function select(
  task: Task,
  tree: RefTree,
  dirty: string[] = [],
  working = false,
  available = inventory(tree),
) {
  const view = source(tree, working ? dirty : undefined);
  const paths = new Set<string>();
  let reason: string | undefined;
  for (const pattern of task.inputs) {
    if (typeof pattern !== 'string') {
      if ('imports-of' in pattern) {
        const found = closure(pattern['imports-of'], view);
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
        if (negative) paths.delete(path);
        else paths.add(path);
      }
    }
    if (!matched) reason ??= `unmatched input '${pattern}'`;
  }
  return { paths, reason };
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
  }
  const selection = select(task, tree);
  if (selection.reason) return { reason: selection.reason };
  const selected: (
    | [string, string | undefined, string | undefined]
    | [string, string | undefined, string, string]
  )[] = [...selection.paths].map((path) => [path, tree.modes.get(path), tree.files.get(path)]);
  selected.sort(([a], [b]) => compare(a, b));
  let cached = contents.get(tree);
  if (!cached) {
    cached = new Map();
    contents.set(tree, cached);
  }
  const projections = task.inputs.filter(
    (input): input is Extract<Input, { path: string }> =>
      typeof input !== 'string' && 'path' in input,
  );
  const members = new Map<string, [string, string, string]>();
  for (const { path, json } of projections) {
    if (!tree.files.has(path)) return { reason: `missing input '${path}'` };
    let source = cached.get(path);
    if (source === undefined) {
      source = tree.read(path);
      cached.set(path, source);
    }
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      return { reason: `input '${path}': invalid JSON` };
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { reason: `input '${path}': not a JSON object` };
    }
    const object = value as Record<string, unknown>;
    for (const member of json) {
      members.set(JSON.stringify([path, member]), [
        path,
        member,
        Object.hasOwn(object, member)
          ? new Bun.CryptoHasher('sha256').update(canonical(object[member])).digest('hex')
          : 'absent',
      ]);
    }
  }
  selected.push(
    ...[...members.values()]
      .sort(([ap, am], [bp, bm]) => compare(ap, bp) || compare(am, bm))
      .map(([path, member, hash]): [string, string | undefined, string, string] => [
        path,
        tree.modes.get(path),
        member,
        hash,
      ]),
  );
  const tuple: unknown[] = [
    2,
    id,
    { run: task.run, ...(task.links?.length ? { links: task.links } : {}) },
    selected,
  ];
  if (task.env?.length) {
    tuple.push(
      task.env.map((name) => {
        const value = process.env[name];
        return [
          'env',
          name,
          value === undefined
            ? 'absent'
            : new Bun.CryptoHasher('sha256').update(value).digest('hex'),
        ];
      }),
    );
  }
  const hash = new Bun.CryptoHasher('sha256').update(JSON.stringify(tuple)).digest('hex');
  return { key: hash };
}

import type { Task } from './declarations';
import type { RefTree } from './git';
import { select } from './key';

const contents = new WeakMap<RefTree, Map<string, string>>();

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

export function hash(value: string) {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

export function keyParts(task: Task, tree: RefTree, historical = false) {
  const selection = select(task, tree);
  const unavailable = [...tree.unavailable].sort().map((path) => `unavailable input '${path}'`);
  selection.reason ??= unavailable[0];
  const reasons = [
    ...(selection.reason ? [selection.reason] : []),
    ...unavailable.filter((reason) => reason !== selection.reason),
  ];
  const files: [string, string, string][] = [];
  let cached = contents.get(tree);
  if (!cached) {
    cached = new Map();
    contents.set(tree, cached);
  }
  const projections = new Set<string>();
  const members = new Map<string, [string, string, string, string]>();
  for (const path of [...selection.paths].sort()) {
    const { mode, blob } = tree.entry(path);
    if (mode && blob) files.push([path, mode, blob]);
    else reasons.push(`unavailable input '${path}'`);
  }
  for (const input of task.inputs) {
    if (typeof input === 'string' || !('path' in input)) continue;
    const { path, json } = input;
    for (const member of json) projections.add(JSON.stringify([path, member]));
    const { mode } = tree.entry(path);
    if (!tree.files.has(path)) {
      reasons.push(`missing input '${path}'`);
      continue;
    }
    if (!mode) {
      reasons.push(`unavailable input '${path}'`);
      continue;
    }
    let value: unknown;
    try {
      let text = cached.get(path);
      if (text === undefined) {
        text = tree.read(path);
        cached.set(path, text);
      }
      value = JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      reasons.push(`input '${path}': invalid JSON`);
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      reasons.push(`input '${path}': not a JSON object`);
      continue;
    }
    const object = value as Record<string, unknown>;
    for (const member of json)
      members.set(JSON.stringify([path, member]), [
        path,
        mode,
        member,
        Object.hasOwn(object, member) ? hash(canonical(object[member])) : 'absent',
      ]);
  }
  const declaration = { run: task.run, ...(task.links?.length ? { links: task.links } : {}) };
  const env: [string, string][] = historical
    ? []
    : (task.env ?? []).map((name) => [
        name,
        process.env[name] === undefined ? 'absent' : hash(process.env[name]),
      ]);
  return {
    tree,
    selection,
    projections,
    declaration,
    declarationHash: hash(JSON.stringify(declaration)),
    files,
    members: [...members.values()].sort(
      ([ap, , am], [bp, , bm]) => compare(ap, bp) || compare(am, bm),
    ),
    env,
    reasons: [...new Set(reasons)],
  };
}

import type { Task } from './declarations';
import type { RefTree } from './git';
import { select } from './key';

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
  const reasons = selection.reason ? [selection.reason] : [];
  const files: [string, string, string][] = [];
  const members = new Map<string, [string, string, string, string]>();
  for (const path of [...selection.paths].sort()) {
    const mode = tree.modes.get(path);
    const blob = tree.files.get(path);
    if (mode && blob) files.push([path, mode, blob]);
    else reasons.push(`unavailable input '${path}'`);
  }
  for (const input of task.inputs) {
    if (typeof input === 'string' || !('path' in input)) continue;
    const { path, json } = input;
    const mode = tree.modes.get(path);
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
      value = JSON.parse(tree.read(path));
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
    declaration,
    declarationHash: hash(JSON.stringify(declaration)),
    files,
    members: [...members.values()].sort(
      ([ap, , am], [bp, , bm]) => compare(ap, bp) || compare(am, bm),
    ),
    env,
    reasons,
  };
}

import type { Task } from './declarations';
import { dimension } from './dimensions';
import { dotenv } from './dotenv';
import type { RefTree } from './git';
import { select } from './key';
import { workingFile } from './sandbox';
import { manifestMembers } from './workspaces';

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
  function read(path: string) {
    let text = cached?.get(path);
    if (text === undefined) {
      text = tree.read(path);
      cached?.set(path, text);
    }
    return text;
  }
  const projections = new Set<string>();
  const members = new Map<string, [string, string, string, string]>();
  for (const path of [...selection.paths].sort()) {
    if (selection.manifests.includes(path)) continue;
    const { mode, blob } = tree.entry(path);
    if (mode && blob) {
      let identity = blob;
      if (path === 'package.json' || path.endsWith('/package.json')) {
        const text = read(path);
        try {
          const value = JSON.parse(text);
          if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            const version = JSON.stringify(value.version);
            const literal = version?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Preserve layout; the first matching nested version is an accepted rare corner.
            identity = hash(
              literal === undefined
                ? text
                : text.replace(new RegExp(`("version"\\s*:\\s*)${literal}`), '$1""'),
            );
          }
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
      files.push([path, mode, identity]);
    } else reasons.push(`unavailable input '${path}'`);
  }
  for (const input of [
    ...task.inputs,
    ...selection.manifests.map((path) => ({ path, json: manifestMembers })),
  ]) {
    if (typeof input === 'string' || !('path' in input)) continue;
    const { path } = input;
    const json = 'json' in input ? input.json : [];
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
    if ('dotenv-keys' in input) {
      const member = 'dotenv-keys';
      const id = JSON.stringify([path, member]);
      projections.add(id);
      if (mode !== '100644' && mode !== '100755') {
        reasons.push(`input '${path}': not a regular file`);
        continue;
      }
      try {
        const names = [...dotenv(read(path), path).keys()].sort();
        members.set(id, [path, mode, member, hash(JSON.stringify(names))]);
      } catch (error) {
        reasons.push(
          error instanceof Error && error.message.startsWith(`input '${path}': invalid dotenv`)
            ? error.message
            : `unavailable input '${path}'`,
        );
      }
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(read(path));
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
        Object.hasOwn(object, member)
          ? hash(member === 'exports' ? JSON.stringify(object[member]) : canonical(object[member]))
          : 'absent',
      ]);
  }
  const declaration = { run: task.run, ...(task.links?.length ? { links: task.links } : {}) };
  const env: [string, string][] = historical
    ? []
    : (task.env ?? []).map((name) => [
        name,
        process.env[name] === undefined ? 'absent' : hash(process.env[name]),
      ]);
  if (!historical) {
    const entries = new Map(env);
    for (const [name, command] of task.dimensions ?? []) {
      const resolved = dimension(name, command);
      if (resolved.value !== undefined) entries.set(`dimension:${name}`, hash(resolved.value));
      else reasons.push(resolved.reason);
    }
    for (const input of task.inputs) {
      if (typeof input === 'string' || !('dotenv' in input)) continue;
      const path = input.dotenv;
      let source: string;
      try {
        const file = workingFile(path);
        if (!file) {
          reasons.push(`missing input '${path}'`);
          continue;
        }
        source = file.bytes.toString();
      } catch {
        reasons.push(`unavailable input '${path}'`);
        continue;
      }
      try {
        for (const [name, value] of dotenv(source, path))
          if (!input.exclude?.includes(name)) entries.set(`${path}:${name}`, hash(value));
      } catch (error) {
        reasons.push((error as Error).message);
      }
    }
    env.splice(0, env.length, ...[...entries].sort(([a], [b]) => compare(a, b)));
  }
  return {
    tree,
    selection,
    projections,
    declaration,
    declarationHash: hash(JSON.stringify(declaration)),
    unkeyed: [
      ...new Set([
        ...selection.paths,
        ...task.inputs.flatMap((input) =>
          typeof input !== 'string' && 'path' in input ? [input.path] : [],
        ),
      ]),
    ]
      .filter((path) => task.unkeyed?.has(path))
      .sort(),
    files: files.filter(([path]) => !task.unkeyed?.has(path)),
    members: [...members.values()]
      .filter(([path]) => !task.unkeyed?.has(path))
      .sort(([ap, , am], [bp, , bm]) => compare(ap, bp) || compare(am, bm)),
    env,
    reasons: [...new Set(reasons)],
  };
}

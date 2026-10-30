import { posix } from 'node:path';
import type { Source } from './imports';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('expected configuration object');
  return value as Record<string, unknown>;
}
function matches(pattern: string, value: string) {
  const parts = pattern.split('*');
  if (parts.length > 2) throw new Error(`unsupported alias '${pattern}'`);
  return parts.length === 1
    ? value === pattern
    : value.startsWith(parts[0] ?? '') &&
        value.endsWith(parts[1] ?? '') &&
        value.length >= pattern.length - 1;
}
function packageMatch(name: string, edge: string) {
  return edge === name || edge.startsWith(`${name}/`);
}
export function metadata(view: Source, resolve: (path: string) => string | undefined) {
  let packages: { name?: string; workspaces: string[] } | undefined;
  function names() {
    if (packages) return packages;
    const text = view.read('package.json');
    const root = text === undefined ? {} : object(JSON.parse(text));
    const workspaces: string[] = [];
    if (root.name !== undefined && typeof root.name !== 'string')
      throw new Error('invalid package name');
    if (root.workspaces !== undefined) {
      const patterns = root.workspaces;
      if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== 'string'))
        throw new Error('unsupported workspaces');
      for (const path of view.paths) {
        if (!path.endsWith('/package.json')) continue;
        if (!patterns.some((p) => new Bun.Glob(`${p}/package.json`).match(path))) continue;
        const pkg = object(JSON.parse(view.read(path) ?? 'null'));
        if (typeof pkg.name !== 'string') throw new Error(`${path}: missing package name`);
        workspaces.push(pkg.name);
      }
    }
    packages = { name: root.name as string | undefined, workspaces };
    return packages;
  }
  type Config = { paths?: string[]; base?: string };
  const configs = new Map<string, Config>();
  function config(path: string, stack: string[] = []): Config {
    const cached = configs.get(path);
    if (cached) return cached;
    if (stack.includes(path)) throw new Error(`${path}: cyclic extends`);
    const text = view.read(path);
    if (text === undefined) throw new Error(`${path}: missing tsconfig`);
    const doc = object(Bun.JSONC.parse(text));
    let result: Config = {};
    if (doc.extends !== undefined) {
      const parents = Array.isArray(doc.extends) ? doc.extends : [doc.extends];
      for (const parent of parents) {
        if (typeof parent !== 'string') throw new Error(`${path}: unsupported extends`);
        if (!parent.startsWith('.'))
          throw new Error(`${path}: external extends '${parent}' not followed`);
        let target = posix.join(posix.dirname(path), parent);
        if (target.startsWith('../')) throw new Error(`${path}: external extends not followed`);
        if (view.read(target) === undefined) target += '.json';
        result = { ...result, ...config(target, [...stack, path]) };
      }
    }
    if (doc.compilerOptions !== undefined) {
      const options = object(doc.compilerOptions);
      if (options.paths !== undefined) {
        const paths = object(options.paths);
        for (const [key, targets] of Object.entries(paths)) {
          matches(key, '');
          if (!Array.isArray(targets) || targets.some((p) => typeof p !== 'string'))
            throw new Error(`${path}: unsupported paths`);
        }
        result.paths = Object.keys(paths);
      }
      if (options.baseUrl !== undefined) {
        if (typeof options.baseUrl !== 'string') throw new Error(`${path}: unsupported baseUrl`);
        result.base = posix.join(posix.dirname(path), options.baseUrl);
      }
    }
    configs.set(path, result);
    return result;
  }
  return (importer: string, edge: string) => {
    const root = names();
    if (root.workspaces.some((name) => packageMatch(name, edge)))
      return 'workspace import not followed';
    if (edge.startsWith('#') || (root.name && packageMatch(root.name, edge)))
      return 'local import not followed';
    let dir = posix.dirname(importer);
    for (;;) {
      const path = posix.join(dir, 'tsconfig.json');
      if (view.mode(path)) {
        const options = config(path);
        if (options.paths?.some((pattern) => matches(pattern, edge)))
          return 'workspace import not followed';
        if (options.base && resolve(posix.join(options.base, edge)))
          return 'local import not followed';
        break;
      }
      if (dir === '.') break;
      dir = posix.dirname(dir);
    }
    return undefined;
  };
}

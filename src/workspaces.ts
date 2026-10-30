import { isBuiltin } from 'node:module';
import { posix } from 'node:path';
import type { Source } from './imports';

export type Edge = { specifier: string; kind: 'import' | 'require' };
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('expected configuration object');
  return value as Record<string, unknown>;
}
const extensions = ['.tsx', '.ts', '.jsx', '.cts', '.cjs', '.js', '.mjs', '.mts', '.json'];
function safe(path: string) {
  if (path.startsWith('../') || path.startsWith('/') || path.split('/').includes('.git'))
    throw new Error(`unsafe import target '${path}'`);
  return path;
}
const readers = new WeakMap<Source, ReturnType<typeof reader>>();
export function workspaces(view: Source) {
  let result = readers.get(view);
  if (!result) {
    result = reader(view);
    readers.set(view, result);
  }
  return result;
}
function reader(view: Source) {
  function json(path: string) {
    const text = view.read(path);
    if (text === undefined) throw new Error(`${path}: missing configuration`);
    return object(JSON.parse(text));
  }
  let packages: Map<string, string> | undefined;
  let rootName: unknown;
  function names() {
    if (packages) return packages;
    const found = new Map<string, string>();
    const root = view.read('package.json') === undefined ? {} : json('package.json');
    rootName = root.name;
    if (rootName !== undefined && typeof rootName !== 'string')
      throw new Error('invalid package name');
    let patterns = root.workspaces;
    if (patterns !== undefined) {
      if (!Array.isArray(patterns)) patterns = object(patterns).packages;
      if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== 'string'))
        throw new Error('unsupported workspaces');
      const globs = (patterns as string[]).map((p) => ({
        negative: p.startsWith('!'),
        glob: new Bun.Glob(
          `${p.replace(/^!/, '').replace(/^\.\//, '').replace(/\/+$/, '')}/package.json`,
        ),
      }));
      for (const path of view.paths) {
        if (!path.endsWith('/package.json')) continue;
        if (
          !globs.some((g) => !g.negative && g.glob.match(path)) ||
          globs.some((g) => g.negative && g.glob.match(path))
        )
          continue;
        if (view.read(path) === undefined) continue;
        const pkg = json(path);
        if (typeof pkg.name !== 'string') throw new Error(`${path}: missing package name`);
        if (found.has(pkg.name)) throw new Error(`duplicate workspace package '${pkg.name}'`);
        found.set(pkg.name, posix.dirname(path));
      }
    }
    packages = found;
    return found;
  }
  function file(path: string, ambiguous = false) {
    safe(path);
    if (view.mode(path)) return path;
    const candidates = extensions.map((ext) => path + ext).filter((p) => view.mode(p));
    if (ambiguous && candidates.length > 1) throw new Error(`ambiguous import target '${path}'`);
    if (candidates.length) return candidates[0];
    if (path.endsWith('.js'))
      return ['.ts', '.tsx'].map((ext) => path.slice(0, -3) + ext).find((p) => view.mode(p));
    return undefined;
  }
  function resolve(
    path: string,
    deps: Set<string>,
    ambiguous = false,
    stack: string[] = [],
  ): string | undefined {
    safe(path);
    if (stack.includes(path)) throw new Error(`cyclic package entry '${path}'`);
    const direct = file(path, ambiguous);
    if (direct) return direct;
    const manifest = posix.join(path, 'package.json');
    let pkg: Record<string, unknown> = {};
    if (view.mode(manifest)) {
      deps.add(manifest);
      pkg = json(manifest);
    }
    function entry(value: unknown) {
      if (typeof value !== 'string') throw new Error(`${manifest}: unsupported entry`);
      const target = resolve(posix.join(path, value), deps, true, [...stack, path]);
      if (!target) throw new Error(`${manifest}: missing entry '${value}'`);
      return target;
    }
    if (pkg.main !== undefined) return entry(pkg.main);
    const indexes = extensions
      .map((ext) => posix.join(path, `index${ext}`))
      .filter((p) => view.mode(p));
    if (indexes.length > 1) throw new Error(`ambiguous directory index '${path}'`);
    if (indexes.length) return indexes[0];
    if (pkg.module !== undefined) return entry(pkg.module);
    return undefined;
  }
  type Config = {
    paths?: Record<string, string[]>;
    origin?: string;
    base?: string;
    deps: string[];
  };
  const configs = new Map<string, Config>();
  function config(path: string, stack: string[] = []): Config {
    safe(path);
    if (stack.includes(path)) throw new Error(`${path}: cyclic extends`);
    const cached = configs.get(path);
    if (cached) return cached;
    const text = view.read(path);
    if (text === undefined) throw new Error(`${path}: missing tsconfig`);
    const doc = object(Bun.JSONC.parse(text));
    let result: Config = { deps: [path] };
    if (doc.extends !== undefined) {
      for (const parent of Array.isArray(doc.extends) ? doc.extends : [doc.extends]) {
        if (typeof parent !== 'string') throw new Error(`${path}: unsupported extends`);
        let target: string | undefined;
        if (parent.startsWith('.')) target = posix.join(posix.dirname(path), parent);
        else {
          const pkg = [...names()].find(
            ([name]) => parent === name || parent.startsWith(`${name}/`),
          );
          if (pkg) {
            const manifest = `${pkg[1]}/package.json`;
            result.deps.push(manifest);
            target = posix.join(pkg[1], parent.slice(pkg[0].length) || 'tsconfig.json');
          }
        }
        // Bun ignores package-named extends outside the workspace.
        if (target === undefined) continue;
        if (view.read(target) === undefined) target += '.json';
        const inherited = config(target, [...stack, path]);
        result = { ...result, ...inherited, deps: [...result.deps, ...inherited.deps] };
      }
    }
    if (doc.compilerOptions !== undefined) {
      const options = object(doc.compilerOptions);
      if (options.paths !== undefined) {
        const paths = object(options.paths);
        for (const [key, targets] of Object.entries(paths)) {
          if (
            key.split('*').length > 2 ||
            !Array.isArray(targets) ||
            targets.some((p) => typeof p !== 'string')
          )
            throw new Error(`${path}: unsupported paths`);
        }
        result.paths = paths as Record<string, string[]>;
        result.origin = posix.dirname(path);
      }
      if (options.baseUrl !== undefined) {
        if (typeof options.baseUrl !== 'string') throw new Error(`${path}: unsupported baseUrl`);
        result.base = safe(posix.join(posix.dirname(path), options.baseUrl));
      }
    }
    configs.set(path, result);
    return result;
  }
  function governing(importer: string) {
    let dir = posix.dirname(importer);
    for (;;) {
      for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const path = posix.join(dir, name);
        if (view.mode(path)) return config(path);
      }
      if (dir === '.') return undefined;
      dir = posix.dirname(dir);
    }
  }
  function exported(value: unknown, kind: Edge['kind']): string | undefined {
    if (typeof value === 'string') return value;
    const conditions = object(value);
    for (const [condition, target] of Object.entries(conditions)) {
      if (['bun', 'node', 'node-addons', kind, 'default'].includes(condition)) {
        const chosen = exported(target, kind);
        if (chosen !== undefined) return chosen;
      }
    }
    return undefined;
  }
  function bare(importer: string, edge: Edge, deps: Set<string>) {
    const spec = edge.specifier;
    if (spec.startsWith('bun:') || spec.startsWith('node:') || isBuiltin(spec)) return;
    if (view.mode('package.json')) deps.add('package.json');
    const options = governing(importer);
    for (const path of options?.deps ?? []) deps.add(path);
    const aliases = Object.entries(options?.paths ?? {})
      .filter(([pattern]) => {
        const [prefix, suffix] = pattern.split('*');
        return suffix === undefined
          ? spec === pattern
          : spec.startsWith(prefix ?? '') &&
              spec.endsWith(suffix) &&
              spec.length >= pattern.length - 1;
      })
      .sort(
        ([a], [b]) =>
          Number(a.includes('*')) - Number(b.includes('*')) ||
          (b.split('*')[0]?.length ?? 0) - (a.split('*')[0]?.length ?? 0) ||
          b.length - a.length,
      );
    const alias = aliases[0];
    if (alias) {
      const [pattern, targets] = alias;
      const [prefix, suffix] = pattern.split('*');
      const capture =
        suffix === undefined ? '' : spec.slice(prefix?.length ?? 0, spec.length - suffix.length);
      for (const target of targets) {
        const found = resolve(
          posix.join(options?.base ?? options?.origin ?? '.', target.replace('*', capture)),
          deps,
        );
        if (found) return found;
      }
      throw new Error(`unresolved paths alias '${spec}'`);
    }
    if (options?.base && resolve(posix.join(options.base, spec), deps))
      throw new Error('local import not followed (baseUrl)');
    const pkg = [...names()].find(([name]) => spec === name || spec.startsWith(`${name}/`));
    if (pkg) {
      const [name, dir] = pkg;
      const manifest = `${dir}/package.json`;
      deps.add(manifest);
      const doc = json(manifest);
      const sub = spec === name ? '.' : `.${spec.slice(name.length)}`;
      if (Object.hasOwn(doc, 'exports')) {
        try {
          let value = doc.exports;
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            const map = object(value);
            const keys = Object.keys(map);
            if (keys.some((k) => k.startsWith('.'))) {
              if (keys.some((k) => !k.startsWith('.') || k.includes('*')))
                throw new Error('unsupported subpath map');
              value = map[sub];
            } else if (sub !== '.') value = undefined;
          } else if (sub !== '.') value = undefined;
          const target = exported(value, edge.kind);
          if (
            !target?.startsWith('./') ||
            target.split('/').includes('..') ||
            target.split('/').includes('node_modules')
          )
            throw new Error('unsupported target');
          const found = resolve(posix.join(dir, target), deps);
          if (!found) throw new Error(`missing target '${target}'`);
          return found;
        } catch (error) {
          throw new Error(`${name}: unsupported exports resolution: ${error}`);
        }
      }
      const target = resolve(sub === '.' ? dir : posix.join(dir, sub), deps, sub !== '.');
      if (!target) throw new Error(`${name}: unresolved package entry`);
      return target;
    }
    if (
      spec.startsWith('#') ||
      (typeof rootName === 'string' && (spec === rootName || spec.startsWith(`${rootName}/`)))
    )
      throw new Error('local import not followed');
  }
  return { names, resolve, bare };
}

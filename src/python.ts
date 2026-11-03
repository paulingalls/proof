import { posix } from 'node:path';
import type { Source } from './imports';
import { pythonScan } from './python-scan';

const indexes = new WeakMap<Source, Map<string, string>>();
function localNames(view: Source) {
  const prior = indexes.get(view);
  if (prior) return prior;
  const names = new Map<string, string>();
  for (const path of view.paths) {
    if (!path.endsWith('.py')) continue;
    names.set(posix.basename(path, '.py'), path);
    let dir = posix.dirname(path);
    while (dir !== '.') {
      names.set(posix.basename(dir), dir);
      dir = posix.dirname(dir);
    }
  }
  indexes.set(view, names);
  return names;
}
type Module = { files: string[]; dirs: string[] };
export function pythonClosure(entry: string, view: Source, roots = [posix.dirname(entry)]) {
  const tracked = new Set(view.paths);
  const paths = new Set<string>();
  const directories = new Set<string>();
  for (const path of tracked) {
    if (!path.endsWith('.py')) continue;
    let dir = posix.dirname(path);
    while (dir !== '.') {
      directories.add(dir);
      dir = posix.dirname(dir);
    }
    directories.add('.');
  }
  let reason: string | undefined;
  function resolve(name: string, search: string[]): Module | undefined {
    const files: string[] = [];
    let dirs = search;
    const parts = name.split('.');
    for (const [i, part] of parts.entries()) {
      const portions: string[] = [];
      let found: Module | undefined;
      for (const root of dirs) {
        const base = posix.join(root, part);
        if (tracked.has(`${base}/__init__.py`)) {
          found = { files: [`${base}/__init__.py`], dirs: [base] };
          break;
        }
        if (tracked.has(`${base}.py`)) {
          found = { files: [`${base}.py`], dirs: [] };
          break;
        }
        if (directories.has(base)) portions.push(base);
      }
      found ??= portions.length ? { files: [], dirs: portions } : undefined;
      if (!found) return undefined;
      files.push(...found.files);
      dirs = found.dirs;
      if (i < parts.length - 1 && !dirs.length) return undefined;
    }
    return { files, dirs };
  }
  function visit(path: string) {
    if (paths.has(path)) return;
    paths.add(path);
    const mode = view.mode(path);
    if (mode !== '100644' && mode !== '100755') {
      reason ??= `${path}: ${mode ? `unsupported mode ${mode}` : 'missing entry'}`;
      return;
    }
    const text = view.read(path);
    if (text === undefined) {
      reason ??= `${path}: missing entry`;
      return;
    }
    for (const edge of pythonScan(text).imports) {
      let module: Module | undefined;
      if (edge.name.startsWith('.')) {
        const dots = /^\.+/.exec(edge.name)?.[0].length ?? 0;
        let dir = posix.dirname(path);
        for (let n = 1; n < dots; n++) dir = posix.join(dir, '..');
        if (dir === '..' || dir.startsWith('../')) {
          reason ??= `${path}: import '${edge.name}': unresolved relative import`;
          continue;
        }
        const base = edge.name.slice(dots);
        module = base
          ? resolve(base, [dir])
          : {
              files: tracked.has(posix.join(dir, '__init__.py'))
                ? [posix.join(dir, '__init__.py')]
                : [],
              dirs: [dir],
            };
      } else module = resolve(edge.name, roots);
      for (const dep of module?.files ?? []) visit(dep);
      let childFound = false;
      for (const member of edge.members ?? []) {
        const child = module && resolve(member, module.dirs);
        childFound ||= !!child;
        for (const dep of child?.files ?? []) visit(dep);
      }
      if (edge.name.startsWith('.')) {
        if (!module || (!edge.name.replaceAll('.', '') && !module.files.length && !childFound))
          reason ??= `${path}: import '${edge.name}': unresolved relative import`;
      } else if (!module) {
        const local = localNames(view).get(edge.name.split('.')[0] as string);
        if (local)
          reason ??= `${path}: import '${edge.name}': unresolved; tracked ${local} (check python-path)`;
      }
    }
  }
  visit(entry);
  return { paths, whole: new Set(paths), manifests: new Set<string>(), reason };
}

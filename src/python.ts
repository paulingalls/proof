import { posix } from 'node:path';
import type { Source } from './imports';
import { pythonScan } from './python-scan';

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
      const module = resolve(edge.name, roots);
      for (const dep of module?.files ?? []) visit(dep);
    }
  }
  visit(entry);
  return { paths, whole: new Set(paths), manifests: new Set<string>(), reason };
}

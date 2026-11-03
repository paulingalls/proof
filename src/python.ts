import { posix } from 'node:path';
import type { Source } from './imports';

type Token = { text: string; literal?: string };
type PythonImport = { name: string; members?: string[] };

function literal(value: string, prefix: string): string | undefined {
  if (/[fb]/i.test(prefix) || /\\N\{/.test(value)) return undefined;
  if (/r/i.test(prefix)) return value;
  return value.replace(
    /\\(?:\r?\n|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{1,3}|[^\n])/g,
    (sequence) => {
      const code = sequence.slice(1);
      if (code === '\n' || code === '\r\n') return '';
      if (/^[xuU]/.test(code)) {
        const point = Number.parseInt(code.slice(1), 16);
        return point <= 0x10ffff ? String.fromCodePoint(point) : sequence;
      }
      if (/^[0-7]/.test(code)) return String.fromCodePoint(Number.parseInt(code, 8));
      const simple: Record<string, string> = {
        n: '\n',
        r: '\r',
        t: '\t',
        b: '\b',
        f: '\f',
        v: '\v',
        a: '\x07',
        "'": "'",
        '"': '"',
        '\\': '\\',
      };
      return simple[code] ?? sequence;
    },
  );
}

function tokens(source: string): Token[] {
  const result: Token[] = [];
  let i = 0;
  let depth = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const skip = /^(?:[ \t\r]+|#[^\n]*|\\\r?\n)/.exec(rest);
    if (skip) {
      i += skip[0].length;
      continue;
    }
    const quoted = /^(?:[rRuUbBfF]{0,2})("""|'''|"|')/.exec(rest);
    if (quoted) {
      const quote = quoted[1] as string;
      i += quoted[0].length;
      const start = i;
      while (i < source.length && !source.startsWith(quote, i)) {
        if (source[i] === '\\') i++;
        i++;
      }
      const value = source.slice(start, i);
      i += quote.length;
      result.push({
        text: '<string>',
        literal: literal(value, quoted[0].slice(0, -quote.length)),
      });
      continue;
    }
    const word = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(rest);
    if (word) {
      result.push({ text: word[0] });
      i += word[0].length;
      continue;
    }
    const c = source[i++] as string;
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c !== '\n' || depth === 0) result.push({ text: c });
  }
  return result;
}

function pythonScan(source: string) {
  const ts = tokens(source);
  const imports: PythonImport[] = [];
  let reason: string | undefined;
  for (let n = 0; n < ts.length; n++) {
    let call = ts[n]?.text;
    let open = n + 1;
    if (call === 'importlib' && ts[n + 1]?.text === '.' && ts[n + 2]?.text === 'import_module') {
      call = 'importlib.import_module';
      open = n + 3;
    } else if (!['import_module', '__import__'].includes(call ?? '') || ts[n - 1]?.text === '.')
      continue;
    if (ts[open]?.text !== '(') continue;
    const arg = ts[open + 1];
    const end = ts[open + 2]?.text;
    if (
      arg?.literal !== undefined &&
      [')', ','].includes(end ?? '') &&
      !arg.literal.startsWith('.')
    ) {
      imports.push({ name: arg.literal });
    } else reason ??= `${call}(): non-literal module or unsupported relative context`;
  }
  let i = 0;
  function name() {
    let result = '';
    while (ts[i]?.text === '.') result += ts[i++]?.text;
    if (ts[i]?.text !== 'import' && /^[\p{L}_][\p{L}\p{N}_]*$/u.test(ts[i]?.text ?? '')) {
      result += ts[i++]?.text;
      while (ts[i]?.text === '.' && /^[\p{L}_]/u.test(ts[i + 1]?.text ?? '')) {
        result += `.${ts[i + 1]?.text}`;
        i += 2;
      }
    }
    return result;
  }
  function names() {
    const result: string[] = [];
    if (ts[i]?.text === '(') i++;
    while (i < ts.length) {
      const value = name();
      if (!value) break;
      result.push(value);
      if (ts[i]?.text === 'as') i += 2;
      if (ts[i]?.text !== ',') break;
      i++;
    }
    return result;
  }
  while (i < ts.length) {
    const token = ts[i++]?.text;
    if (token === 'from') {
      const base = name();
      if (ts[i]?.text === 'import') {
        i++;
        imports.push({ name: base, members: names() });
      }
    } else if (token === 'import') {
      for (const value of names()) imports.push({ name: value });
    }
  }
  return { imports, reason };
}

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
    let dir = posix.dirname(path);
    while (
      [...roots, posix.dirname(entry)].some(
        (root) => root === '.' || dir === root || dir.startsWith(`${root}/`),
      )
    ) {
      const initializer = posix.join(dir, '__init__.py');
      if (tracked.has(initializer)) visit(initializer);
      if (dir === '.') break;
      dir = posix.dirname(dir);
    }
    const scanned = pythonScan(text);
    if (scanned.reason) reason ??= `${path}: ${scanned.reason}`;
    for (const edge of scanned.imports) {
      const specifier =
        edge.name + (edge.members?.length ? ` import ${edge.members.join(', ')}` : '');
      let module: Module | undefined;
      if (edge.name.startsWith('.')) {
        const dots = /^\.+/.exec(edge.name)?.[0].length ?? 0;
        let dir = posix.dirname(path);
        for (let n = 1; n < dots; n++) dir = posix.join(dir, '..');
        if (dir === '..' || dir.startsWith('../')) {
          reason ??= `${path}: import '${specifier}': unresolved relative import`;
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
          reason ??= `${path}: import '${specifier}': unresolved relative import`;
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

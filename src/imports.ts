import { posix } from 'node:path';
import type { RefTree } from './git';
import { metadata } from './import-metadata';
import { workingFile } from './sandbox';

export type Source = {
  paths: Iterable<string>;
  read(path: string): string | undefined;
  mode(path: string): string | undefined;
};
const sources = new WeakMap<RefTree, Source>();
const blobs = new Map<string, string>();
function committed(tree: RefTree, path: string) {
  const blob = tree.files.get(path) as string;
  let text = blobs.get(blob);
  if (text === undefined) {
    text = tree.read(path);
    blobs.set(blob, text);
  }
  return text;
}
export function source(tree: RefTree, dirty?: string[]): Source {
  const cached = dirty === undefined ? sources.get(tree) : undefined;
  if (cached) return cached;
  const view: Source = {
    paths: [...tree.files.keys()],
    read: (path) =>
      tree.files.has(path) && !dirty?.includes(path)
        ? committed(tree, path)
        : dirty
          ? workingFile(path, true)?.bytes.toString()
          : undefined,
    mode: (path) =>
      tree.files.has(path) && !dirty?.includes(path)
        ? tree.modes.get(path)
        : dirty && workingFile(path, true)
          ? '100644'
          : undefined,
  };
  if (dirty === undefined) sources.set(tree, view);
  return view;
}
const extensions = ['.tsx', '.ts', '.jsx', '.cts', '.cjs', '.js', '.mjs', '.mts', '.json'];
export function resolveImport(path: string, view: Source) {
  if (path.startsWith('../') || path.startsWith('/') || path.split('/').includes('.git')) return;
  const candidates = [
    path,
    ...extensions.map((ext) => path + ext),
    ...extensions.map((ext) => `${path}/index${ext}`),
    ...(path.endsWith('.js') ? [`${path.slice(0, -3)}.ts`, `${path.slice(0, -3)}.tsx`] : []),
  ];
  return candidates.find((candidate) => view.mode(candidate) !== undefined);
}
const gap = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\n]*(?:\n|$))*`;
const literal = /('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)/.source;
function supplement(text: string) {
  const edges: string[] = [];
  let reason: string | undefined;
  function add(value: string) {
    if (value.includes('\\') || value.includes('${')) reason ??= `ambiguous import ${value}`;
    else edges.push(value.slice(1, -1));
  }
  for (const match of text.matchAll(
    new RegExp(String.raw`\b(?:import|require)${gap}\(${gap}`, 'g'),
  )) {
    const tail = text.slice((match.index ?? 0) + match[0].length);
    const arg = new RegExp(String.raw`^${literal}${gap}(?:\)|,)`).exec(tail);
    if (arg?.[1]) add(arg[1]);
    else reason ??= `computed import ${tail.split(')')[0]}`;
  }
  for (const match of text.matchAll(new RegExp(String.raw`\bfrom${gap}${literal}`, 'g'))) {
    if (match[1]) add(match[1]);
  }
  return { edges, reason };
}
const scans = new Map<string, { edges: string[]; reason?: string }>();
function scan(text: string, loader: 'ts' | 'tsx' | 'jsx' | 'js') {
  const id = new Bun.CryptoHasher('sha256').update(text).digest('hex') + loader;
  let result = scans.get(id);
  if (!result) {
    try {
      const extra = supplement(text);
      result = {
        edges: [
          ...new Set([
            ...new Bun.Transpiler({ loader }).scanImports(text).map((edge) => edge.path),
            ...extra.edges,
          ]),
        ],
        reason: extra.reason,
      };
    } catch (error) {
      result = { edges: [], reason: `parse failure: ${error}` };
    }
    scans.set(id, result);
  }
  return result;
}
const closures = new WeakMap<Source, Map<string, { paths: Set<string>; reason?: string }>>();
export function closure(entry: string, view: Source) {
  let cached = closures.get(view);
  if (!cached) {
    cached = new Map();
    closures.set(view, cached);
  }
  const prior = cached.get(entry);
  if (prior) return prior;
  const paths = new Set<string>();
  const local = metadata(view, (path) => resolveImport(path, view));
  let reason: string | undefined;
  function visit(path: string) {
    if (paths.has(path)) return;
    paths.add(path);
    const mode = view.mode(path);
    if (mode !== '100644' && mode !== '100755') {
      reason ??= `${path}: ${mode ? `unsupported mode ${mode}` : 'missing entry'}`;
      return;
    }
    const ext = posix.extname(path);
    const loader = ['.ts', '.mts', '.cts'].includes(ext)
      ? 'ts'
      : ext === '.tsx'
        ? 'tsx'
        : ['.js', '.jsx'].includes(ext)
          ? 'jsx'
          : ['.mjs', '.cjs'].includes(ext)
            ? 'js'
            : undefined;
    if (!loader) return;
    const text = view.read(path);
    if (text === undefined) {
      reason ??= `${path}: missing entry`;
      return;
    }
    const scanned = scan(text, loader);
    if (scanned.reason) reason ??= `${path}: ${scanned.reason}`;
    for (const edge of scanned.edges) {
      if (!edge.startsWith('.')) {
        try {
          const why = edge.startsWith('/') ? 'local import not followed' : local(path, edge);
          if (why) reason ??= `${path}: ${why}: '${edge}'`;
        } catch (error) {
          reason ??= `${path}: import '${edge}': ${error}`;
        }
        continue;
      }
      const target = resolveImport(posix.join(posix.dirname(path), edge), view);
      if (target) visit(target);
      else reason ??= `${path}: unresolved import '${edge}'`;
    }
  }
  if (entry.startsWith('/') || entry.split('/').some((part) => ['..', '.git'].includes(part)))
    return { paths, reason: `unsafe entry '${entry}'` };
  visit(entry);
  const result = { paths, reason };
  cached.set(entry, result);
  return result;
}

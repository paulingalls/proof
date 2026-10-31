import { posix } from 'node:path';
import { type RefTree, readBlobs, WorkingTree } from './git';
import { workingFile } from './sandbox';
import { type Loader, scan } from './scan';
import { workspaces } from './workspaces';

export type Source = {
  paths: Iterable<string>;
  read(path: string): string | undefined;
  mode(path: string): string | undefined;
};
const sources = new WeakMap<RefTree, Source>();
const workingSources = new WeakMap<RefTree, WeakMap<string[], Source>>();
const blobs = new Map<string, string>();
const prefetched = new WeakSet<RefTree>();
function committed(tree: RefTree, path: string) {
  const blob = tree.files.get(path) as string;
  // A working tree's entries name hashes of working bytes, which have no object to batch.
  if (!blobs.has(blob) && !prefetched.has(tree) && !(tree instanceof WorkingTree)) {
    const ids = new Set<string>();
    for (const [path, id] of tree.files) {
      if (
        ['100644', '100755'].includes(tree.modes.get(path) ?? '') &&
        (/\.(?:[cm]?[jt]s|[jt]sx|ya?ml)$/.test(path) ||
          ['package.json', 'tsconfig.json', 'jsconfig.json'].includes(posix.basename(path))) &&
        !blobs.has(id)
      )
        ids.add(id);
    }
    if (ids.size) for (const [id, bytes] of readBlobs(ids)) blobs.set(id, bytes.toString());
    prefetched.add(tree);
  }
  let text = blobs.get(blob);
  if (text === undefined) {
    text = tree.read(path);
    blobs.set(blob, text);
  }
  return text;
}
export function source(tree: RefTree, dirty?: string[]): Source {
  const cached = dirty === undefined ? sources.get(tree) : workingSources.get(tree)?.get(dirty);
  if (cached) return cached;
  const reads = new Map<string, string | undefined>();
  const modes = new Map<string, string | undefined>();
  const view: Source = {
    paths: [...new Set([...tree.files.keys(), ...(dirty ?? [])])],
    read: (path) => {
      if (reads.has(path)) return reads.get(path);
      const text =
        dirty === undefined
          ? tree.entry(path).mode
            ? committed(tree, path)
            : undefined
          : tree.files.has(path) && !dirty.includes(path)
            ? committed(tree, path)
            : workingFile(path, true)?.bytes.toString();
      reads.set(path, text);
      return text;
    },
    mode: (path) => {
      if (modes.has(path)) return modes.get(path);
      const mode =
        dirty === undefined
          ? tree.entry(path).mode
          : tree.files.has(path) && !dirty.includes(path)
            ? tree.modes.get(path)
            : workingFile(path, true)
              ? '100644'
              : undefined;
      modes.set(path, mode);
      return mode;
    },
  };
  if (dirty === undefined) sources.set(tree, view);
  else {
    let views = workingSources.get(tree);
    if (!views) {
      views = new WeakMap();
      workingSources.set(tree, views);
    }
    views.set(dirty, view);
  }
  return view;
}
type ResolvedEdge = { specifier: string; deps: string[]; target?: string; error?: string };
type ResolvedFile = { reason?: string; edges: ResolvedEdge[] };
const resolved = new WeakMap<Source, Map<string, ResolvedFile>>();
function resolvedFile(view: Source, path: string): ResolvedFile {
  let cached = resolved.get(view);
  if (!cached) {
    cached = new Map();
    resolved.set(view, cached);
  }
  const prior = cached.get(path);
  if (prior) return prior;
  const result: ResolvedFile = { edges: [] };
  const mode = view.mode(path);
  if (mode !== '100644' && mode !== '100755') {
    result.reason = `${path}: ${mode ? `unsupported mode ${mode}` : 'missing entry'}`;
  } else {
    const ext = posix.extname(path);
    const loader: Loader | undefined = ['.ts', '.mts', '.cts'].includes(ext)
      ? 'ts'
      : ext === '.tsx'
        ? 'tsx'
        : ['.js', '.jsx'].includes(ext)
          ? 'jsx'
          : ['.mjs', '.cjs'].includes(ext)
            ? 'js'
            : undefined;
    if (loader) {
      const text = view.read(path);
      if (text === undefined) result.reason = `${path}: missing entry`;
      else {
        const scanned = scan(text, loader);
        if (scanned.reason) result.reason = `${path}: ${scanned.reason}`;
        const local = workspaces(view);
        for (const edge of scanned.edges) {
          const spec = edge.specifier;
          const item: ResolvedEdge = { specifier: spec, deps: [] };
          try {
            const deps = new Set<string>();
            if (spec.startsWith('/') || spec.startsWith('file:'))
              throw new Error('local import not followed');
            item.target = spec.startsWith('.')
              ? local.resolve(posix.join(posix.dirname(path), spec), deps)
              : local.bare(path, edge, deps);
            item.deps = [...deps];
            if (!item.target && spec.startsWith('.'))
              item.error = `${path}: import '${spec}': Error: unresolved import`;
          } catch (error) {
            item.error = `${path}: import '${spec}': ${error}`;
          }
          result.edges.push(item);
        }
      }
    }
  }
  cached.set(path, result);
  return result;
}
const closures = new WeakMap<
  Source,
  Map<string, { paths: Set<string>; manifests: Set<string>; whole: Set<string>; reason?: string }>
>();
export function closure(entry: string, view: Source) {
  let cached = closures.get(view);
  if (!cached) {
    cached = new Map();
    closures.set(view, cached);
  }
  const prior = cached.get(entry);
  if (prior) return prior;
  const paths = new Set<string>();
  const manifests = new Set<string>();
  const whole = new Set<string>();
  let reason: string | undefined;
  function visit(path: string, metadata = false) {
    if (!metadata) whole.add(path);
    if (paths.has(path)) return;
    paths.add(path);
    const file = resolvedFile(view, path);
    reason ??= file.reason;
    for (const edge of file.edges) {
      try {
        for (const dep of edge.deps) {
          if (posix.basename(dep) === 'package.json') manifests.add(dep);
          visit(dep, true);
        }
        if (edge.target) visit(edge.target);
        if (edge.error) reason ??= edge.error;
      } catch (error) {
        reason ??= `${path}: import '${edge.specifier}': ${error}`;
      }
    }
  }
  if (entry.startsWith('/') || entry.split('/').some((part) => ['..', '.git'].includes(part)))
    return { paths, manifests, whole, reason: `unsafe entry '${entry}'` };
  visit(entry);
  const result = { paths, manifests, whole, reason };
  cached.set(entry, result);
  return result;
}

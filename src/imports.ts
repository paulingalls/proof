import { posix } from 'node:path';
import type { RefTree } from './git';
import { workingFile } from './sandbox';
import { type Edge, workspaces } from './workspaces';

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
    paths: [...new Set([...tree.files.keys(), ...(dirty ?? [])])],
    read: (path) =>
      dirty === undefined
        ? tree.entry(path).mode
          ? committed(tree, path)
          : undefined
        : tree.files.has(path) && !dirty.includes(path)
          ? committed(tree, path)
          : workingFile(path, true)?.bytes.toString(),
    mode: (path) =>
      dirty === undefined
        ? tree.entry(path).mode
        : tree.files.has(path) && !dirty.includes(path)
          ? tree.modes.get(path)
          : workingFile(path, true)
            ? '100644'
            : undefined,
  };
  if (dirty === undefined) sources.set(tree, view);
  return view;
}
const gap = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\n]*(?:\n|$))*`;
const literal = /('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)/.source;
type Loader = 'ts' | 'tsx' | 'jsx' | 'js';
function supplement(text: string, loader: Loader) {
  const edges: Edge[] = [];
  let reason: string | undefined;
  const call = () => new RegExp(String.raw`\b(?:import|require)${gap}\(${gap}`, 'g');
  const literalArgument = new RegExp(String.raw`^${literal}${gap}(?:\)|,)`);
  // Only the transpiler knows a comment from code; a hand tokenizer desyncs on regex literals and
  // could hide a real call. Its output keeps every call that runs, so it confirms a computed one.
  const runs = () => {
    const code = new Bun.Transpiler({ loader }).transformSync(text);
    return [...code.matchAll(call())].some(
      (match) => !literalArgument.test(code.slice(match.index + match[0].length)),
    );
  };
  function add(value: string, kind: Edge['kind']) {
    if (value.includes('\\') || value.includes('${')) reason ??= `ambiguous import ${value}`;
    else edges.push({ specifier: value.slice(1, -1), kind });
  }
  for (const match of text.matchAll(call())) {
    const tail = text.slice((match.index ?? 0) + match[0].length);
    const arg = literalArgument.exec(tail);
    if (arg?.[1]) add(arg[1], match[0].startsWith('require') ? 'require' : 'import');
    else if (!reason && runs()) reason = `computed import ${tail.split(')')[0]}`;
  }
  for (const match of text.matchAll(new RegExp(String.raw`\bfrom${gap}${literal}`, 'g'))) {
    if (match[1]) add(match[1], 'import');
  }
  return { edges, reason };
}
const scans = new Map<string, { edges: Edge[]; reason?: string }>();
function scan(text: string, loader: Loader) {
  const id = new Bun.CryptoHasher('sha256').update(text).digest('hex') + loader;
  let result = scans.get(id);
  if (!result) {
    try {
      const extra = supplement(text, loader);
      result = {
        edges: [
          ...new Map(
            [
              ...new Bun.Transpiler({ loader }).scanImports(text).map(
                (edge): Edge => ({
                  specifier: edge.path,
                  kind: edge.kind === 'require-call' ? 'require' : 'import',
                }),
              ),
              ...extra.edges,
            ].map((edge) => [JSON.stringify(edge), edge]),
          ).values(),
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
const closures = new WeakMap<
  Source,
  Map<string, { paths: Set<string>; manifests: Set<string>; reason?: string }>
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
  const local = workspaces(view);
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
      try {
        const deps = new Set<string>();
        const spec = edge.specifier;
        if (spec.startsWith('/') || spec.startsWith('file:'))
          throw new Error('local import not followed');
        const target = spec.startsWith('.')
          ? local.resolve(posix.join(posix.dirname(path), spec), deps)
          : local.bare(path, edge, deps);
        for (const dep of deps) {
          if (posix.basename(dep) === 'package.json') manifests.add(dep);
          visit(dep);
        }
        if (target) visit(target);
        else if (spec.startsWith('.')) throw new Error('unresolved import');
      } catch (error) {
        reason ??= `${path}: import '${edge.specifier}': ${error}`;
      }
    }
  }
  if (entry.startsWith('/') || entry.split('/').some((part) => ['..', '.git'].includes(part)))
    return { paths, manifests, reason: `unsafe entry '${entry}'` };
  visit(entry);
  const result = { paths, manifests, reason };
  cached.set(entry, result);
  return result;
}

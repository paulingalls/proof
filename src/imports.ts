import { posix } from 'node:path';
import { type RefTree, readBlobs, WorkingTree } from './git';
import { workingFile } from './sandbox';
import { type Edge, workspaces } from './workspaces';

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
        (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path) ||
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
const gap = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\n]*(?:\n|$))*`;
const literal = /('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)/.source;
// The scanner erases type-only edges; expose them without interpreting import-looking text.
function valueImports(text: string) {
  const name = String.raw`[$\w]+(?![$\w])`;
  const named = String.raw`\{(?:${gap}${name})*(?:${gap},(?:${gap}${name})*)*${gap}\}`;
  const clause = String.raw`(?:${named}|\*(?:${gap}as${gap}${name})?|${name}(?:${gap},${gap}${named})?)`;
  const statement = new RegExp(
    String.raw`\b(import|export)${gap}(type\b${gap})?(${clause})(${gap}from${gap}${literal})`,
    'g',
  );
  const inline = new RegExp(String.raw`(^|,)${gap}type\b${gap}(?!as\b)(${name})`, 'g');
  return text.replace(statement, (_, kind, _type, clause: string, tail) => {
    const values = clause.replace(
      /\{([\s\S]*)\}/,
      (_, names: string) => `{${names.replace(inline, '$1 $2')}}`,
    );
    return `${kind} ${values}${tail}`;
  });
}
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
              ...new Bun.Transpiler({ loader }).scanImports(valueImports(text)).map(
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
  const local = workspaces(view);
  let reason: string | undefined;
  function visit(path: string, metadata = false) {
    if (!metadata) whole.add(path);
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
          visit(dep, true);
        }
        if (target) visit(target);
        else if (spec.startsWith('.')) throw new Error('unresolved import');
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

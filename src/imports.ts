import { posix } from 'node:path';
import type { RefTree } from './git';
import { workingFile } from './sandbox';

export type Source = {
  read(path: string): string | undefined;
  mode(path: string): string | undefined;
};
export function source(tree: RefTree, dirty?: string[]): Source {
  return {
    read: (path) =>
      tree.files.has(path) && !dirty?.includes(path)
        ? tree.read(path)
        : dirty
          ? workingFile(path)?.bytes.toString()
          : undefined,
    mode: (path) =>
      tree.files.has(path) && !dirty?.includes(path)
        ? tree.modes.get(path)
        : dirty && workingFile(path)
          ? '100644'
          : undefined,
  };
}
const extensions = ['.tsx', '.ts', '.jsx', '.cts', '.cjs', '.js', '.mjs', '.mts', '.json'];
export function resolveImport(path: string, view: Source) {
  if (path.startsWith('../') || path.startsWith('/') || path.split('/').includes('.git')) return;
  const candidates = [
    path,
    ...extensions.map((ext) => path + ext),
    ...extensions.map((ext) => `${path}/index${ext}`),
    ...(path.endsWith('.js') ? [path.slice(0, -3) + '.ts', path.slice(0, -3) + '.tsx'] : []),
  ];
  return candidates.find((candidate) => view.mode(candidate) !== undefined);
}
const scans = new Map<string, { edges: string[]; reason?: string }>();
function scan(text: string, loader: 'ts' | 'tsx' | 'jsx' | 'js') {
  const id = new Bun.CryptoHasher('sha256').update(text).digest('hex') + loader;
  let result = scans.get(id);
  if (!result) {
    try {
      result = { edges: new Bun.Transpiler({ loader }).scanImports(text).map((edge) => edge.path) };
    } catch (error) {
      result = { edges: [], reason: `parse failure: ${error}` };
    }
    scans.set(id, result);
  }
  return result;
}
export function closure(entry: string, view: Source) {
  const paths = new Set<string>();
  let reason: string | undefined;
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
    const scanned = scan(text, loader);
    if (scanned.reason) reason ??= `${path}: ${scanned.reason}`;
    for (const edge of scanned.edges) {
      if (!edge.startsWith('.')) continue;
      const target = resolveImport(posix.join(posix.dirname(path), edge), view);
      if (target) visit(target);
      else reason ??= `${path}: unresolved import '${edge}'`;
    }
  }
  visit(entry);
  return { paths, reason };
}

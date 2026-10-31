import { lstatSync } from 'node:fs';
import { workingFile } from './sandbox';

function gitBytes(...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return result.stdout;
}

function git(...args: string[]) {
  return gitBytes(...args).toString();
}

export function resolveRef(ref: string) {
  try {
    return git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
  } catch (error) {
    throw new Error(`ref '${ref}': ${error}`);
  }
}

export function* readBlobs(ids: Iterable<string>) {
  const result = Bun.spawnSync(['git', 'cat-file', '--batch'], {
    stdin: Buffer.from(`${[...ids].join('\n')}\n`),
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  const bytes = result.stdout;
  let offset = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(10, offset);
    if (end < 0) throw new Error('truncated git cat-file header');
    const [id, type, size] = bytes.subarray(offset, end).toString().split(' ');
    if (type !== 'blob') throw new Error(`git cat-file: ${id} ${type}`);
    const length = Number(size);
    offset = end + 1;
    if (!Number.isSafeInteger(length) || length < 0 || bytes[offset + length] !== 10)
      throw new Error('truncated git cat-file blob');
    yield [id as string, bytes.subarray(offset, offset + length)] as const;
    offset += length + 1;
  }
}

export class RefTree {
  readonly commit: string;
  readonly files = new Map<string, string>();
  readonly modes = new Map<string, string>();
  readonly unavailable = new Set<string>();

  static index() {
    return new RefTree(git('write-tree').trim(), 'tree');
  }

  constructor(
    readonly ref: string,
    type: 'commit' | 'tree' = 'commit',
  ) {
    try {
      const oid = git('rev-parse', '--verify', '--end-of-options', `${ref}^{${type}}`).trim();
      this.commit = oid;
      for (const entry of git('ls-tree', '-r', '-z', '--full-tree', oid).split('\0')) {
        if (!entry) continue;
        const tab = entry.indexOf('\t');
        const [mode, type, blob] = entry.slice(0, tab).split(' ');
        // A gitlink's commit oid is its content: a submodule bump must change the key.
        if ((type === 'blob' || type === 'commit') && blob && mode) {
          this.files.set(entry.slice(tab + 1), blob);
          this.modes.set(entry.slice(tab + 1), mode);
        }
      }
    } catch (error) {
      throw new Error(`ref '${ref}': ${error}`);
    }
  }

  entry(path: string) {
    return { mode: this.modes.get(path), blob: this.files.get(path) };
  }

  read(path: string) {
    return this.raw(path).toString();
  }

  raw(path: string) {
    const blob = this.files.get(path);
    if (!blob) throw new Error(`ref '${this.ref}': missing ${path}`);
    return gitBytes('cat-file', 'blob', blob);
  }
}

// Explicit flags override status.renames, status.showUntrackedFiles and submodule ignore config.
export type Scope = { selects: (path: string) => boolean; prefixes?: string[] };

export function dirtyPaths(scope: Scope) {
  const paths = git(
    'status',
    '--porcelain=v1',
    '-z',
    '--no-renames',
    '--untracked-files=all',
    '--ignore-submodules=none',
  )
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.slice(3));
  // An ignored file counts only when a declaration selects it: dependency trees such as
  // node_modules would otherwise block every publication and cost seconds to list.
  const ignored = git(
    'ls-files',
    '-z',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--',
    ...(scope.prefixes ?? []),
  );
  for (const path of ignored.split('\0')) if (path && scope.selects(path)) paths.push(path);
  // Status trusts these index flags, so cleanliness cannot be established for their paths.
  for (const entry of git('ls-files', '-v', '-z').split('\0')) {
    if (/^[a-zS] /.test(entry)) paths.push(entry.slice(2));
  }
  return [...new Set(paths)];
}

export function hasCommit(commit: string) {
  return Bun.spawnSync(['git', 'cat-file', '-e', `${commit}^{commit}`]).exitCode === 0;
}

export class WorkingTree extends RefTree {
  private readonly bytes = new Map<string, Buffer>();
  private readonly visited = new Set<string>();
  private readonly repositories = new Set<string>();
  private readonly dirty: Set<string>;
  private readonly format: 'sha1' | 'sha256';
  private readonly known: Set<string>;

  constructor(tree: RefTree, dirty: string[]) {
    super(tree.commit);
    const format = git('rev-parse', '--show-object-format').trim();
    if (format !== 'sha1' && format !== 'sha256')
      throw new Error(`unsupported object format '${format}'`);
    this.format = format;
    this.dirty = new Set(dirty.map((path) => path.replace(/\/+$/, '')));
    for (const path of this.dirty) {
      const state = workingEntry(path);
      if (state === 'deleted') {
        this.files.delete(path);
        this.modes.delete(path);
      } else if (state === 'unsupported' || state === 'repository') {
        if (state === 'repository') this.repositories.add(path);
        this.files.set(path, '');
        this.modes.delete(path);
      } else this.files.set(path, this.files.get(path) ?? '');
    }
    this.known = new Set(this.files.keys());
  }

  override entry(path: string) {
    if (path.startsWith('/') || path.split('/').some((part) => ['..', '.git'].includes(part)))
      return { mode: undefined, blob: undefined };
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (
        this.repositories.has(parent) ||
        (i < parts.length && this.modes.get(parent) === '160000')
      ) {
        this.unavailable.add(parent);
        return { mode: undefined, blob: undefined };
      }
    }
    if (this.visited.has(path)) return super.entry(path);
    this.visited.add(path);
    const mode = this.modes.get(path);
    if (!this.dirty.has(path) && mode) return super.entry(path);
    const state = workingEntry(path);
    if (state === 'deleted') {
      this.files.delete(path);
      this.modes.delete(path);
    } else if (state === 'unsupported' || state === 'repository') {
      if (this.known.has(path)) this.unavailable.add(path);
      this.files.set(path, '');
      this.modes.delete(path);
    } else {
      const file = workingFile(path);
      if (!file) throw new Error(`working input disappeared '${path}'`);
      const blob = new Bun.CryptoHasher(this.format)
        .update(`blob ${file.bytes.length}\0`)
        .update(file.bytes)
        .digest('hex');
      this.files.set(path, blob);
      this.modes.set(path, file.executable ? '100755' : '100644');
      this.bytes.set(path, file.bytes);
    }
    return super.entry(path);
  }

  override raw(path: string) {
    this.entry(path);
    return this.bytes.get(path) ?? super.raw(path);
  }
}

function workingEntry(path: string): 'regular' | 'deleted' | 'unsupported' | 'repository' {
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(parts.slice(0, i).join('/'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'deleted';
      throw error;
    }
    if (i === parts.length && stat.isDirectory()) {
      try {
        lstatSync(`${path}/.git`);
        return 'repository';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (i < parts.length ? !stat.isDirectory() : !stat.isFile()) return 'unsupported';
  }
  return 'regular';
}

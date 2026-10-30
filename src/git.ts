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

export class RefTree {
  readonly commit: string;
  readonly files = new Map<string, string>();
  readonly modes = new Map<string, string>();

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

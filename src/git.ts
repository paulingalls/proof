function git(...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return result.stdout.toString();
}

export class RefTree {
  readonly commit: string;
  readonly files = new Map<string, string>();

  constructor(readonly ref: string) {
    try {
      const oid = git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
      this.commit = oid;
      for (const entry of git('ls-tree', '-r', '-z', '--full-tree', oid).split('\0')) {
        if (!entry) continue;
        const tab = entry.indexOf('\t');
        const [, type, blob] = entry.slice(0, tab).split(' ');
        // A gitlink's commit oid is its content: a submodule bump must change the key.
        if ((type === 'blob' || type === 'commit') && blob)
          this.files.set(entry.slice(tab + 1), blob);
      }
    } catch (error) {
      throw new Error(`ref '${ref}': ${error}`);
    }
  }

  read(path: string) {
    const blob = this.files.get(path);
    if (!blob) throw new Error(`ref '${this.ref}': missing ${path}`);
    return git('cat-file', 'blob', blob);
  }
}

// Explicit flags override status.renames, status.showUntrackedFiles and submodule ignore config.
export function dirtyPaths() {
  const paths = git(
    'status',
    '--porcelain=v1',
    '-z',
    '--no-renames',
    '--untracked-files=all',
    '--ignored=traditional',
    '--ignore-submodules=none',
  )
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.slice(3));
  // Status trusts these index flags, so cleanliness cannot be established for their paths.
  for (const entry of git('ls-files', '-v', '-z').split('\0')) {
    if (/^[a-zS] /.test(entry)) paths.push(entry.slice(2));
  }
  return [...new Set(paths)];
}

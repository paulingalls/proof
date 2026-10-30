function git(...args: string[]) {
  const result = Bun.spawnSync(['git', ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return result.stdout.toString();
}

export class RefTree {
  readonly files = new Map<string, string>();

  constructor(readonly ref: string) {
    try {
      const oid = git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
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

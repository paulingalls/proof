import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import type { RefTree } from './git';

type File = { bytes: Buffer; executable: boolean };

function workingFile(path: string): File | undefined {
  // Refuse links in parent directories too: a working-tree read must never follow a link.
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const part = parts.slice(0, i).join('/');
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(part);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`selected path '${part}': symlink`);
    if (i < parts.length && !stat.isDirectory())
      throw new Error(`selected path '${part}': not a directory`);
    if (i === parts.length) {
      if (!stat.isFile()) throw new Error(`selected path '${path}': not a regular file`);
      return { bytes: readFileSync(path), executable: Boolean(stat.mode & 0o111) };
    }
  }
}

export class Sandbox {
  readonly path = mkdtempSync(join(tmpdir(), 'proof-sandbox-'));
  private readonly files = new Map<string, File | undefined>();

  materialize(paths: Set<string>, tree: RefTree, dirty: string[]) {
    for (const path of paths) {
      const target = join(this.path, path);
      if (relative(this.path, target).startsWith('..') || path.split('/').includes('.git'))
        throw new Error(`unsafe selected path '${path}'`);
      const mode = tree.modes.get(path);
      const file = dirty.includes(path)
        ? workingFile(path)
        : mode === undefined
          ? undefined
          : this.committedFile(path, mode, tree);
      this.files.set(path, file);
      if (!file) continue;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes);
      chmodSync(target, file.executable ? 0o755 : 0o644);
    }
  }

  link(paths: string[]) {
    for (const path of paths) {
      try {
        const source = realpathSync(resolve(path));
        const parts = path.split('/');
        for (let i = 1; i <= parts.length; i++) {
          const target = join(this.path, ...parts.slice(0, i));
          let stat: ReturnType<typeof lstatSync> | undefined;
          try {
            stat = lstatSync(target);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          if (stat && (i === parts.length || !stat.isDirectory() || stat.isSymbolicLink()))
            throw new Error(`destination overlaps selected content or another link`);
          if (i < parts.length && !stat) mkdirSync(target);
        }
        symlinkSync(source, join(this.path, path));
      } catch (error) {
        throw new Error(`link '${path}': ${error}`);
      }
    }
  }

  private committedFile(path: string, mode: string, tree: RefTree): File {
    if (mode !== '100644' && mode !== '100755')
      throw new Error(
        `selected path '${path}': ${mode === '120000' ? 'symlink' : mode === '160000' ? 'gitlink' : mode}`,
      );
    return { bytes: tree.raw(path), executable: mode === '100755' };
  }

  changed() {
    for (const [path, before] of this.files) {
      const after = workingFile(path);
      if (
        before?.executable !== after?.executable ||
        (before && after && !before.bytes.equals(after.bytes))
      )
        return path;
    }
  }

  close() {
    rmSync(this.path, { recursive: true, force: true });
  }
}

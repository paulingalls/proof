import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { RefTree } from './git';

type File = { bytes: Buffer; executable: boolean };

export function workingFile(path: string, candidate = false): File | undefined {
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
    if (
      candidate &&
      ((i < parts.length && !stat.isDirectory()) || (i === parts.length && !stat.isFile()))
    )
      return undefined;
    if (i < parts.length && !stat.isDirectory())
      throw new Error(`selected path '${part}': not a directory`);
    if (i === parts.length) {
      if (!stat.isFile()) throw new Error(`selected path '${path}': not a regular file`);
      return { bytes: readFileSync(path), executable: Boolean(stat.mode & 0o111) };
    }
  }
}

function within(root: string, path: string) {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('../'));
}

function entries(path: string) {
  try {
    return readdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

type ModuleEntry = { path: string; redirect?: string };
type ModuleDirectory = { scopes: string[]; entries: ModuleEntry[] };

export function inspectLinks(
  paths: string[],
  tracked: Iterable<string>,
  workspaceNames: () => Map<string, string>,
) {
  const trusted: string[] = [];
  const escapes: string[] = [];
  const modules = new Map<string, ModuleDirectory>();
  if (!paths.length) return { trusted, escapes, modules };
  const trackedPaths = [...tracked];
  const repo = realpathSync('.');
  for (const path of paths) {
    try {
      let root: string;
      try {
        root = realpathSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        trusted.push(path);
        continue;
      }
      // Bytes reached through a link are not in the key, so a link may not reach tracked files.
      const base = within(repo, root) ? relative(repo, root) : undefined;
      const reached =
        base === undefined
          ? undefined
          : trackedPaths.find((file) => !base || file === base || file.startsWith(`${base}/`));
      if (reached) {
        escapes.push(`link '${path}' reaches tracked '${reached}'`);
        continue;
      }
      if (!lstatSync(root).isDirectory()) {
        trusted.push(path);
        continue;
      }
      const before = escapes.length;
      const layout: ModuleDirectory = { scopes: [], entries: [] };
      const nodeModules = basename(path) === 'node_modules';
      if (nodeModules) modules.set(path, layout);
      const names = (file: string) => {
        try {
          return workspaceNames();
        } catch (error) {
          escapes.push(`link escape '${file}': workspace discovery: ${error}`);
        }
      };
      const check = (file: string, packageName?: string) => {
        let target: string;
        try {
          target = realpathSync(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        }
        if (within(repo, target) && !within(root, target)) {
          const mapped = packageName ? names(file)?.get(packageName) : undefined;
          if (mapped !== undefined && target === resolve(repo, mapped)) {
            const entry = layout.entries.find((entry) => entry.path === file);
            if (entry) entry.redirect = mapped;
            return;
          }
          escapes.push(`link escape '${file}' -> '${target}'`);
          return;
        }
        if (!packageName) return;
        const manifest = join(file, 'package.json');
        let text: string;
        try {
          text = readFileSync(manifest, 'utf8');
        } catch (error) {
          if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
          throw error;
        }
        try {
          const doc = JSON.parse(text);
          const dependencies = new Set<string>();
          for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
            if (doc[field] !== undefined) {
              if (!doc[field] || typeof doc[field] !== 'object' || Array.isArray(doc[field]))
                throw new Error(`invalid ${field}`);
              for (const name of Object.keys(doc[field])) dependencies.add(name);
            }
          }
          if (dependencies.size) {
            const packages = names(file);
            for (const name of dependencies) {
              if (packages?.has(name))
                escapes.push(
                  `link escape installed package '${packageName}' declares workspace '${name}'`,
                );
            }
          }
        } catch (error) {
          escapes.push(`link escape '${manifest}': ${error}`);
        }
      };
      for (const child of readdirSync(root)) {
        const file = join(path, child);
        const stat = lstatSync(file);
        let scope = false;
        if (nodeModules && child.startsWith('@')) {
          try {
            scope = lstatSync(realpathSync(file)).isDirectory();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        if (scope) {
          layout.scopes.push(file);
          for (const entry of readdirSync(file)) {
            const nested = join(file, entry);
            layout.entries.push({ path: nested });
            check(nested, `${child}/${entry}`);
          }
        } else {
          if (nodeModules) layout.entries.push({ path: file });
          if (nodeModules && !child.startsWith('.')) check(file, child);
          else if (stat.isSymbolicLink()) check(file);
          if (stat.isDirectory()) {
            for (const entry of readdirSync(file)) {
              const nested = join(file, entry);
              if (lstatSync(nested).isSymbolicLink()) check(nested);
            }
          }
        }
      }
      for (const python of entries(join(path, 'lib')).filter((name) => name.startsWith('python'))) {
        const site = join(path, 'lib', python, 'site-packages');
        for (const name of entries(site).filter((name) => name.endsWith('.pth'))) {
          const file = join(site, name);
          for (const line of readFileSync(file, 'utf8').split(/\r\n|\n|\r/)) {
            const entry = line.trimEnd();
            if (!entry || entry.startsWith('#') || /^import[ \t]/.test(entry)) continue;
            let target: string;
            try {
              target = realpathSync(resolve(site, entry));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
              throw error;
            }
            if (within(repo, target) && !within(root, target))
              escapes.push(`link escape '${file}' -> '${target}'`);
          }
        }
      }
      if (escapes.length === before) trusted.push(path);
    } catch (error) {
      throw new Error(`link '${path}': ${error}`);
    }
  }
  return { trusted, escapes, modules };
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
      const file =
        dirty.includes(path) || mode === undefined
          ? workingFile(path)
          : this.committedFile(path, mode, tree);
      this.files.set(path, file);
      if (!file) continue;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes);
      chmodSync(target, file.executable ? 0o755 : 0o644);
    }
  }

  link(paths: string[], inspection: ReturnType<typeof inspectLinks>) {
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
        const layout = inspection.modules.get(path);
        if (layout) {
          mkdirSync(join(this.path, path));
          for (const scope of layout.scopes) mkdirSync(join(this.path, scope));
          for (const entry of layout.entries) {
            symlinkSync(
              entry.redirect === undefined ? resolve(entry.path) : join(this.path, entry.redirect),
              join(this.path, entry.path),
            );
          }
        } else symlinkSync(source, join(this.path, path));
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

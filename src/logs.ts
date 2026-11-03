import {
  closeSync,
  copyFileSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { statePath } from './config';
import type { RefTree } from './git';
import { source } from './imports';
import { workspaces } from './workspaces';

export type LogIdentity = {
  project: string;
  kind: 'tasks' | 'providers' | 'generators';
  task: string;
  key?: string;
  live: boolean;
};
export type LogResult = { path?: string; artifacts?: string; error?: string };

const CHUNK = 65536;

function segment(name: string) {
  return name === '.' || name === '..' ? name.replaceAll('.', '%2E') : encodeURIComponent(name);
}

function shellArgument(path: string) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\"'\"'")}'`;
}

export function logSuffix(result: LogResult) {
  return result.error
    ? `; log failed: ${result.error}`
    : result.path
      ? `; log: ${shellArgument(result.path)}${result.artifacts ? `; artifacts: ${shellArgument(result.artifacts)}` : ''}`
      : '';
}

export function redDiagnostics(path: string, root: string, tree: RefTree, selected: Set<string>) {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    // Retained logs are optional diagnostic evidence; capture errors are handled separately.
    return { omitted: [], git: false };
  }
  const omitted = new Set<string>();
  let git = false;
  let unresolved: string | undefined;
  let filterCwd: string | undefined;
  const addPath = (candidate: string, cwd: string) => {
    const file = relative(root, resolve(cwd, candidate));
    if (tree.files.has(file) && !selected.has(file)) omitted.add(file);
  };
  for (const line of content.split('\n')) {
    if (filterCwd && /^\s+\S/.test(line)) {
      for (const filter of line.trim().split(/\s+/)) addPath(filter, filterCwd);
    }
    filterCwd = undefined;
    const module = /Module not found "([^"]+)"/.exec(line);
    if (module) addPath(module[1] as string, root);
    const singleFilter = /^Test filter "([^"]+)" had no matches in --cwd="([^"]+)"$/.exec(line);
    const filters = /^The following filters did not match any test files in --cwd="([^"]+)":$/.exec(
      line,
    );
    const cwd = singleFilter?.[2] ?? filters?.[1];
    if (cwd) {
      const directory = resolve(root, cwd);
      const local = relative(root, directory);
      if (local !== '..' && !local.startsWith('../') && !isAbsolute(local)) {
        if (singleFilter) addPath(singleFilter[1] as string, directory);
        else filterCwd = directory;
      }
    }
    if (line.includes('not a git repository')) git = true;
    if (/^\s*error:/.test(line)) unresolved = undefined;
    const spec = /Could not resolve: "([^"]+)"/.exec(line);
    if (spec) unresolved = spec[1];
    const at = /^\s+at (\/.*)/.exec(line);
    if (at && unresolved) {
      const importer = (at[1] as string).replace(/:\d+(?::\d+)?$/, '');
      const local = relative(root, importer);
      if (
        local !== '..' &&
        !local.startsWith('../') &&
        !isAbsolute(local) &&
        /^\.\.?\//.test(unresolved)
      ) {
        try {
          const file = workspaces(source(tree)).resolve(
            relative(root, resolve(dirname(importer), unresolved)),
            new Set(),
          );
          if (file && tree.files.has(file) && !selected.has(file)) omitted.add(file);
        } catch {
          // Resolution is optional diagnostic evidence; the original red remains authoritative.
        }
      }
      unresolved = undefined;
    }
    for (const match of line.matchAll(/Cannot find (?:module|package) (['"])(.*?)\1/g)) {
      const resolver = workspaces(source(tree));
      for (const kind of ['import', 'require'] as const) {
        try {
          const target = resolver.bare(
            'package.json',
            { specifier: match[2] ?? '', kind },
            new Set(),
          );
          if (target && tree.files.has(target) && !selected.has(target)) omitted.add(target);
        } catch {
          // Resolution is optional diagnostic evidence; the original red remains authoritative.
        }
      }
    }
    const missing = /no such file or directory|ENOENT/i.exec(line);
    if (!missing) continue;
    const field = line.slice(0, missing.index).split(': ').at(-2) ?? '';
    const quoted = [...line.matchAll(/(?:^|[^\w])(['"])(.*?)\1/g)].map((match) => match[2] ?? '');
    for (const candidate of [...quoted, field, field.split(/\s+/).at(-1) ?? '']) {
      if (!candidate) continue;
      const file = relative(root, resolve(root, candidate));
      if (tree.files.has(file) && !selected.has(file)) omitted.add(file);
    }
  }
  return { omitted: [...omitted], git };
}

export function notDelivered(paths: string[]) {
  return paths.length
    ? `; not delivered: ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` (+${paths.length - 3} more)` : ''}`
    : '';
}

export function logTail(path: string) {
  try {
    const content = readFileSync(path, 'utf8').replace(/\n$/, '');
    return content === ''
      ? []
      : content
          .split('\n')
          .slice(-20)
          .map((line) => `  ${line}`);
  } catch (error) {
    return [`  log tail unavailable: ${error}`];
  }
}

export class Capture {
  readonly fd: number;
  private readonly root = resolve(statePath(), 'logs');
  private readonly id = crypto.randomUUID();
  private readonly path = join(this.root, `${this.id}.capture`);
  private readonly buffer = Buffer.alloc(CHUNK);
  private offset = 0;
  private lastByte?: number;
  private error?: string;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly identity: LogIdentity) {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.fd = openSync(this.path, 'wx+', 0o600);
    if (identity.live) this.timer = setInterval(() => this.tail(this.offset + CHUNK), 10);
  }

  // Stopping at `end` returns to the event loop: a writer outrunning stdout must not starve the
  // signal handlers, and a background survivor must not hold the final drain open.
  private tail(end: number) {
    if (this.error) return;
    try {
      const buffer = this.buffer;
      while (this.offset < end) {
        const size = Math.min(CHUNK, end - this.offset);
        const count = readSync(this.fd, buffer, 0, size, this.offset);
        if (!count) break;
        this.offset += count;
        let written = 0;
        while (written < count) written += writeSync(1, buffer, written, count - written);
        this.lastByte = buffer[count - 1];
      }
    } catch (error) {
      this.error = String(error);
    }
  }

  display() {
    clearInterval(this.timer);
    try {
      if (this.identity.live) {
        this.tail(fstatSync(this.fd).size);
        if (this.lastByte !== undefined && this.lastByte !== 10) writeSync(1, '\n');
      } else {
        const bytes = readFileSync(this.path);
        console.log(
          `--- ${this.identity.kind === 'providers' ? 'provider-' : ''}${this.identity.task}\n${bytes.toString().replace(/\n$/, '')}`,
        );
      }
    } catch (error) {
      this.error = String(error);
    } finally {
      this.close();
    }
  }

  close() {
    clearInterval(this.timer);
    try {
      closeSync(this.fd);
    } catch (error) {
      this.error = String(error);
    }
  }

  finish(
    outcome: 'green' | 'red' | 'incomplete',
    sandbox?: { root: string; patterns: string[] },
  ): LogResult {
    let path: string | undefined;
    let artifacts: string | undefined;
    let artifactDirectory: string | undefined;
    try {
      if (outcome === 'green') unlinkSync(this.path);
      else {
        const directory = join(
          this.root,
          segment(this.identity.project),
          this.identity.kind,
          segment(this.identity.task),
        );
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
        path = join(
          directory,
          `${timestamp}-${this.id}-${this.identity.key?.slice(0, 8) ?? 'no-key'}-${outcome}.log`,
        );
        renameSync(this.path, path);
        const logs = readdirSync(directory)
          .filter((name) => name.endsWith('.log'))
          .sort();
        for (const name of logs.slice(0, -10)) {
          try {
            rmSync(join(directory, name.slice(0, -4)), { recursive: true, force: true });
            unlinkSync(join(directory, name));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        if (sandbox?.patterns.length) {
          artifactDirectory = path.slice(0, -4);
          const files = new Set(
            sandbox.patterns.flatMap((pattern) => [
              ...new Bun.Glob(pattern).scanSync({ cwd: sandbox.root, dot: true }),
            ]),
          );
          for (const file of files) {
            const target = join(artifactDirectory, file);
            mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
            copyFileSync(join(sandbox.root, file), target);
            artifacts = artifactDirectory;
          }
        }
      }
    } catch (error) {
      this.error = artifactDirectory ? `${artifactDirectory}: ${error}` : String(error);
    }
    return this.error ? { error: this.error } : { path, artifacts };
  }
}

import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
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
export type LogResult = { path?: string; error?: string };

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
      ? `; log: ${shellArgument(result.path)}`
      : '';
}

export function notDelivered(path: string, root: string, tree: RefTree, selected: Set<string>) {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    // Retained logs are optional diagnostic evidence; capture errors are handled separately.
    return '';
  }
  const omitted = new Set<string>();
  for (const line of content.split('\n')) {
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
  const paths = [...omitted];
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

  finish(outcome: 'green' | 'red' | 'incomplete'): LogResult {
    let path: string | undefined;
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
            unlinkSync(join(directory, name));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
      }
    } catch (error) {
      this.error = String(error);
    }
    return this.error ? { error: this.error } : { path };
  }
}

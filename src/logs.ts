import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { statePath } from './config';

export type LogIdentity = { project: string; task: string; key?: string; live: boolean };
export type LogResult = { path?: string; error?: string };

function segment(name: string) {
  return name === '.' || name === '..' ? name.replaceAll('.', '%2E') : encodeURIComponent(name);
}

export function logSuffix(result: LogResult) {
  return result.error
    ? `; log failed: ${result.error}`
    : result.path
      ? `; log: ${result.path}`
      : '';
}

export class Capture {
  readonly fd: number;
  private readonly root = resolve(statePath(), 'logs');
  private readonly path = join(this.root, `${crypto.randomUUID()}.capture`);
  private offset = 0;
  private error?: string;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly identity: LogIdentity) {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.fd = openSync(this.path, 'wx+', 0o600);
    if (identity.live) this.timer = setInterval(() => this.tail(), 10);
  }

  private tail() {
    if (this.error) return;
    try {
      const buffer = Buffer.alloc(65536);
      while (true) {
        const count = readSync(this.fd, buffer, 0, buffer.length, this.offset);
        if (!count) break;
        this.offset += count;
        let written = 0;
        while (written < count) written += writeSync(1, buffer, written, count - written);
      }
    } catch (error) {
      this.error = String(error);
    }
  }

  display() {
    clearInterval(this.timer);
    try {
      if (this.identity.live) this.tail();
      else {
        const bytes = readFileSync(this.path);
        console.log(`--- ${this.identity.task}\n${bytes.toString().replace(/\n$/, '')}`);
      }
    } catch (error) {
      this.error = String(error);
    } finally {
      try {
        closeSync(this.fd);
      } catch (error) {
        this.error = String(error);
      }
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
          segment(this.identity.task),
        );
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
        path = join(
          directory,
          `${timestamp}-${this.identity.key?.slice(0, 8) ?? 'no-key'}-${outcome}.log`,
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

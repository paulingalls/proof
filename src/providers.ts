import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { statePath } from './config';
import type { Provider, Task } from './declarations';
import { type LogResult, logSuffix } from './logs';

export const BASE_ENV = ['PATH', 'HOME', 'TMPDIR'];
const CHANNEL = 'PROOF_PROVIDER_ENV';
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ProviderEnvironment = {
  env: NodeJS.ProcessEnv;
  accept: () => string | undefined;
};

type Attempt = {
  env: Record<string, string>;
  declaration: Provider;
  ready: boolean;
  stopped: boolean;
  starting: Promise<boolean>;
};

export class Providers {
  private readonly attempts = new Map<string, Attempt>();

  constructor(
    private readonly execute: (
      command: string,
      cleanup: boolean,
      name: string,
      environment?: ProviderEnvironment,
    ) => Promise<LogResult & { ready: boolean; problem?: string }>,
    private readonly report: (message: string) => void,
    private readonly tasks: () => Iterable<Task>,
  ) {}

  attempted(needs: string[]) {
    return needs.some((name) => this.attempts.has(name));
  }

  live() {
    return [...this.attempts.values()].some((attempt) => !attempt.stopped);
  }

  async start(name: string, declaration: Provider) {
    const previous = this.attempts.get(name);
    if (previous) return previous.starting;
    const attempt: Attempt = {
      declaration,
      env: {},
      ready: false,
      stopped: false,
      starting: Promise.resolve(false),
    };
    this.attempts.set(name, attempt);
    attempt.starting = this.startAttempt(name, attempt);
    return attempt.starting;
  }

  private async startAttempt(name: string, attempt: Attempt) {
    let directory: string | undefined;
    try {
      let path: string;
      try {
        directory = mkdtempSync(join(resolve(statePath()), 'provider-env-'));
        path = join(directory, 'env');
        closeSync(openSync(path, 'wx', 0o600));
      } catch {
        this.report(`provider '${name}' start failed: cannot create environment channel`);
        return false;
      }
      const result = await this.execute(attempt.declaration.start, false, name, {
        env: { ...process.env, [CHANNEL]: path },
        accept: () => this.accept(name, attempt, path),
      });
      attempt.ready = result.ready;
      if (!result.ready || result.error)
        this.report(
          `provider '${name}' ${result.ready ? 'start ready' : 'start failed'}${result.problem ? `: ${result.problem}` : ''}${logSuffix(result)}`,
        );
      return result.ready;
    } finally {
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  }

  private accept(provider: string, attempt: Attempt, path: string): string | undefined {
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      return 'cannot read environment channel';
    }
    const lines = content === '' ? [] : content.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const env: Record<string, string> = Object.create(null);
    const tasks = [...this.tasks()].filter((task) => task.needs?.includes(provider));
    for (const [index, line] of lines.entries()) {
      const equals = line.indexOf('=');
      const name = line.slice(0, equals);
      const where = `environment line ${index + 1}`;
      if (equals < 0 || !NAME.test(name)) return `${where}: invalid name`;
      const named = `${where} '${name}'`;
      if ([...BASE_ENV, CHANNEL].includes(name)) return `${named}: reserved name`;
      if (Object.hasOwn(env, name)) return `${named}: duplicate name`;
      // Bun's spawn error includes the value when an environment string contains NUL.
      if (line.includes('\0')) return `${named}: NUL is not allowed`;
      for (const task of tasks) {
        if (task.env?.includes(name)) return `${named}: conflicts with declared env`;
        for (const other of task.needs ?? []) {
          if (other !== provider && Object.hasOwn(this.attempts.get(other)?.env ?? {}, name))
            return `${named}: conflicts with provider '${other}'`;
        }
      }
      env[name] = line.slice(equals + 1);
    }
    attempt.env = env;
  }

  environment(needs: string[]) {
    const env: Record<string, string> = {};
    for (const name of needs) {
      if (!this.ready(name)) throw new Error(`provider '${name}' is not ready`);
      Object.assign(env, this.attempts.get(name)?.env);
    }
    return env;
  }

  ready(name: string) {
    const attempt = this.attempts.get(name);
    if (!attempt || attempt.stopped)
      throw new Error(`provider '${name}' is ${attempt ? 'already stopped' : 'not started'}`);
    return attempt.ready;
  }

  async stopExcept(remaining: Set<string>) {
    for (const [name, attempt] of this.attempts) {
      if (attempt.stopped || remaining.has(name)) continue;
      attempt.stopped = true;
      attempt.env = {};
      if (!attempt.declaration.stop) continue;
      try {
        if ((await this.execute(attempt.declaration.stop, true, name)).ready) continue;
      } catch (error) {
        this.report(`provider '${name}' stop failed: ${error}`);
        continue;
      }
      this.report(`provider '${name}' stop failed`);
    }
  }
}

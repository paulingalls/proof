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
  name: string;
  slot?: number;
  env: Record<string, string>;
  declaration: Provider;
  ready: boolean;
  stopped: boolean;
  starting: Promise<boolean>;
};

export class Providers {
  private readonly attempts = new Map<string, Map<number | undefined, Attempt>>();

  constructor(
    private readonly execute: (
      command: string,
      cleanup: boolean,
      name: string,
      environment?: ProviderEnvironment,
    ) => Promise<LogResult & { ready: boolean; problem?: string }>,
    private readonly report: (message: string) => void,
    private readonly tasks: () => Iterable<Task>,
    private readonly initial: Map<string, Provider>,
  ) {}

  attempted(needs: string[]) {
    return needs.some((name) => this.attempts.has(name));
  }

  private instances() {
    return [...this.attempts.values()].flatMap((instances) => [...instances.values()]);
  }

  private instanceSlot(name: string, slot?: number) {
    const provider = this.initial.get(name);
    if (!provider) throw new Error(`unknown provider '${name}' at run entry`);
    return provider.lane === undefined ? undefined : slot;
  }

  validate(needs: string[], lane?: string) {
    for (const name of needs) {
      const required = this.initial.get(name)?.lane;
      if (required !== undefined && required !== lane)
        throw new Error(`provider '${name}' requires frozen lane '${required}'`);
    }
  }

  attemptedInstance(name: string, slot?: number) {
    return this.attempts.get(name)?.has(this.instanceSlot(name, slot)) ?? false;
  }

  live() {
    return this.instances().some((attempt) => !attempt.stopped);
  }

  async start(name: string, declaration: Provider, slot?: number) {
    slot = this.instanceSlot(name, slot);
    const instances = this.attempts.get(name) ?? new Map<number | undefined, Attempt>();
    const previous = instances.get(slot);
    if (previous) return previous.starting;
    const attempt: Attempt = {
      name,
      slot,
      declaration,
      env: {},
      ready: false,
      stopped: false,
      starting: Promise.resolve(false),
    };
    this.attempts.set(name, instances);
    instances.set(slot, attempt);
    attempt.starting = this.startAttempt(this.display(attempt), attempt);
    return attempt.starting;
  }

  private display(attempt: Attempt) {
    return attempt.slot === undefined ? attempt.name : `${attempt.name}[${attempt.slot}]`;
  }

  private processEnv(attempt: Attempt) {
    const env = { ...process.env };
    delete env.PROOF_LANE_SLOT;
    delete env[CHANNEL];
    if (attempt.slot !== undefined) env.PROOF_LANE_SLOT = String(attempt.slot);
    return env;
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
        env: { ...this.processEnv(attempt), [CHANNEL]: path },
        accept: () => this.accept(attempt.name, attempt, path),
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
          if (
            other !== provider &&
            [...(this.attempts.get(other)?.values() ?? [])].some((instance) =>
              Object.hasOwn(instance.env, name),
            )
          )
            return `${named}: conflicts with provider '${other}'`;
        }
      }
      env[name] = line.slice(equals + 1);
    }
    attempt.env = env;
  }

  environment(needs: string[], slot?: number) {
    const env: Record<string, string> = Object.create(null);
    for (const name of needs) {
      if (!this.ready(name, slot)) throw new Error(`provider '${name}' is not ready`);
      Object.assign(env, this.attempts.get(name)?.get(this.instanceSlot(name, slot))?.env);
    }
    return env;
  }

  ready(name: string, slot?: number) {
    const attempt = this.attempts.get(name)?.get(this.instanceSlot(name, slot));
    if (!attempt || attempt.stopped)
      throw new Error(`provider '${name}' is ${attempt ? 'already stopped' : 'not started'}`);
    return attempt.ready;
  }

  async stopExcept(remaining: Set<string>) {
    for (const attempt of this.instances()) {
      const name = this.display(attempt);
      if (attempt.stopped || remaining.has(attempt.name)) continue;
      attempt.stopped = true;
      if (!attempt.declaration.stop) continue;
      try {
        if (
          (
            await this.execute(attempt.declaration.stop, true, name, {
              env: this.processEnv(attempt),
              accept: () => undefined,
            })
          ).ready
        )
          continue;
      } catch (error) {
        this.report(`provider '${name}' stop failed: ${error}`);
        continue;
      }
      this.report(`provider '${name}' stop failed`);
    }
  }
}

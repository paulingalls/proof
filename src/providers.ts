import type { Provider } from './declarations';
import { type LogResult, logSuffix } from './logs';

type Attempt = {
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
    ) => Promise<LogResult & { ready: boolean }>,
    private readonly report: (message: string) => void,
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
      ready: false,
      stopped: false,
      starting: Promise.resolve(false),
    };
    this.attempts.set(name, attempt);
    attempt.starting = this.execute(declaration.start, false, name).then((result) => {
      const { ready } = result;
      attempt.ready = ready;
      if (!ready || result.error)
        this.report(
          `provider '${name}' ${ready ? 'start ready' : 'start failed'}${logSuffix(result)}`,
        );
      return ready;
    });
    return attempt.starting;
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

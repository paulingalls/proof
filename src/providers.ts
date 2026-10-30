import type { Provider } from './declarations';

type Attempt = { declaration: Provider; ready: boolean; stopped: boolean };

export class Providers {
  private readonly attempts = new Map<string, Attempt>();

  constructor(
    private readonly execute: (command: string, cleanup?: boolean) => Promise<boolean>,
    private readonly report: (message: string) => void,
  ) {}

  attempted(needs: string[]) {
    return needs.some((name) => this.attempts.has(name));
  }

  async start(name: string, declaration: Provider) {
    const previous = this.attempts.get(name);
    if (previous) return this.ready(name);
    const attempt = { declaration, ready: false, stopped: false };
    this.attempts.set(name, attempt);
    attempt.ready = await this.execute(declaration.start);
    if (!attempt.ready) this.report(`provider '${name}' start failed`);
    return attempt.ready;
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
        if (await this.execute(attempt.declaration.stop, true)) continue;
      } catch (error) {
        this.report(`provider '${name}' stop failed: ${error}`);
        continue;
      }
      this.report(`provider '${name}' stop failed`);
    }
  }
}

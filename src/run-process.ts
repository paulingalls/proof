import { Capture, type LogIdentity } from './logs';

function signalGroup(pid: number, signal: NodeJS.Signals | 0) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // macOS answers EPERM while the group's only members are zombies awaiting their reaper.
    if (code === 'EPERM') return true;
    if (code !== 'ESRCH') throw error;
    return false;
  }
}

export class RunProcesses {
  interrupted: 'SIGINT' | 'SIGTERM' | undefined;
  aborted = false;
  private readonly active = new Map<ReturnType<typeof Bun.spawn>, boolean>();
  get cancelled() {
    return this.aborted || this.interrupted !== undefined;
  }
  abort() {
    this.aborted = true;
    for (const [child, stopping] of this.active) if (!stopping) signalGroup(child.pid, 'SIGKILL');
  }
  private interrupt(signal: 'SIGINT' | 'SIGTERM') {
    // A shell's background jobs may ignore SIGINT; retain groups until they have drained.
    if (this.interrupted) {
      for (const child of this.active.keys()) signalGroup(child.pid, 'SIGKILL');
      return;
    }
    this.interrupted = signal;
    for (const [child, stopping] of this.active) if (!stopping) signalGroup(child.pid, signal);
  }
  private readonly onInt = () => this.interrupt('SIGINT');
  private readonly onTerm = () => this.interrupt('SIGTERM');
  constructor() {
    process.on('SIGINT', this.onInt);
    process.on('SIGTERM', this.onTerm);
  }
  close() {
    process.off('SIGINT', this.onInt);
    process.off('SIGTERM', this.onTerm);
  }
  async execute(
    command: string,
    cwd: string,
    env = process.env,
    stopping = false,
    identity?: LogIdentity,
  ) {
    if (this.cancelled && !stopping) return { code: 1, signal: 'SIGKILL' as const };
    const capture = identity ? new Capture(identity) : undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let completed = false;
    try {
      child = Bun.spawn(['sh', '-c', command], {
        detached: true,
        cwd,
        env,
        stdout: capture?.fd ?? 'inherit',
        stderr: capture?.fd ?? 'inherit',
      });
      this.active.set(child, stopping);
      const code = await child.exited;
      // A shell may exit before its foreground child has finished handling the signal.
      if (this.cancelled && !stopping) while (signalGroup(child.pid, 0)) await Bun.sleep(10);
      completed = true;
      return { code, signal: child.signalCode, capture };
    } finally {
      if (child) this.active.delete(child);
      capture?.display();
      if (!completed) capture?.finish(child ? 'incomplete' : 'green');
    }
  }
}

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
  private active: ReturnType<typeof Bun.spawn> | undefined;
  private cleanup = false;
  private interrupt(signal: 'SIGINT' | 'SIGTERM') {
    if (this.interrupted) {
      if (this.active) signalGroup(this.active.pid, 'SIGKILL');
      return;
    }
    this.interrupted = signal;
    if (this.active && !this.cleanup) signalGroup(this.active.pid, signal);
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
  async execute(command: string, cwd: string, env = process.env, stopping = false) {
    this.cleanup = stopping;
    const child = Bun.spawn(['sh', '-c', command], {
      detached: true,
      cwd,
      env,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    this.active = child;
    try {
      const code = await child.exited;
      // A shell may exit before its foreground child has finished handling the signal.
      if (this.interrupted && !stopping) while (signalGroup(child.pid, 0)) await Bun.sleep(10);
      return { code, signal: child.signalCode };
    } finally {
      this.active = undefined;
      this.cleanup = false;
    }
  }
}

import { availableParallelism, cpus } from 'node:os';

export function hostCapacity() {
  const value = process.env.PROOF_CPUS;
  if (value === undefined) return availableParallelism();
  const capacity = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(capacity))
    throw new Error('PROOF_CPUS must be a positive safe integer');
  return capacity;
}

// Bun evaluates CPU times lazily; copy counters while capturing each snapshot.
const snapshot = () => cpus().map(({ times }) => ({ ...times }));

export class HostCpu {
  private reading?: { busy: number; start: number };
  private lastAdmission = -Infinity;
  private error?: Error;
  private notify!: () => void;
  next!: Promise<void>;
  private fail!: () => void;
  readonly failure = new Promise<void>((resolve) => {
    this.fail = resolve;
  });
  private timer?: ReturnType<typeof setInterval>;

  constructor(private capacity: number) {
    this.renew();
    try {
      let previous = snapshot();
      let start = performance.now();
      if (!previous.length) throw new Error('empty CPU snapshot');
      this.timer = setInterval(() => {
        try {
          const current = snapshot();
          const end = performance.now();
          if (!current.length || current.length !== previous.length)
            throw new Error('empty snapshot or changed CPU count');
          let busy = 0;
          for (const [index, times] of current.entries()) {
            const before = previous[index] as (typeof previous)[number];
            const total = Object.keys(times).reduce(
              (sum, name) =>
                sum + times[name as keyof typeof times] - before[name as keyof typeof times],
              0,
            );
            const fraction = (total - (times.idle - before.idle)) / total;
            if (!(total > 0) || !Number.isFinite(fraction))
              throw new Error('non-positive CPU counter delta or non-finite busy fraction');
            busy += fraction;
          }
          this.reading = { busy, start };
          previous = current;
          start = end;
          const notify = this.notify;
          this.renew();
          notify();
        } catch (error) {
          this.failed(error);
        }
      }, 1000);
    } catch (error) {
      this.failed(error);
    }
  }

  private renew() {
    this.next = new Promise<void>((resolve) => {
      this.notify = resolve;
    });
  }

  private failed(error: unknown) {
    this.error = new Error(`host CPU sampler: ${error instanceof Error ? error.message : error}`);
    this.close();
    this.fail();
  }

  check() {
    if (this.error) throw this.error;
  }

  permits(active: number) {
    this.check();
    if (!active) return true;
    // Before the first reading, admit as without a gate: a wait here reorders work around
    // providers (bug-fd365994), and a large repo's planning outlasts the first interval.
    if (!this.reading) return true;
    const { busy, start } = this.reading;
    return busy <= this.capacity / 2 || (busy < this.capacity && start >= this.lastAdmission);
  }

  admitted() {
    this.lastAdmission = performance.now();
  }

  close() {
    clearInterval(this.timer);
  }
}

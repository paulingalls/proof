export class Lanes {
  private readonly retired = new Map<string, Set<number>>();
  private readonly occupied = new Map<string, Set<number>>();

  private readonly limits: Map<string, number>;

  constructor(declared: Map<string, number>, override = process.env.PROOF_LANES) {
    this.limits = new Map(declared);
    if (override === undefined) return;
    const seen = new Set<string>();
    for (const entry of override.split(',')) {
      const match = /^([^\s,=]+)=([1-9][0-9]*)$/.exec(entry);
      if (!match || !Number.isSafeInteger(Number(match[2])))
        throw new Error('PROOF_LANES: expected name=N,... with positive safe integers');
      const name = match[1] as string;
      if (!declared.has(name)) throw new Error(`PROOF_LANES: unknown lane '${name}'`);
      if (seen.has(name)) throw new Error(`PROOF_LANES: duplicate lane '${name}'`);
      seen.add(name);
      this.limits.set(name, Number(match[2]));
    }
  }

  capacity(lane: string) {
    const limit = this.limits.get(lane);
    if (limit === undefined) throw new Error(`unknown lane '${lane}'`);
    return Math.max(1, limit - (this.retired.get(lane)?.size ?? 0));
  }

  allocate(lane?: string): { slot?: number; exhausted?: string } {
    if (lane === undefined || lane === 'solo') return {};
    const occupied = this.occupied.get(lane) ?? new Set<number>();
    this.occupied.set(lane, occupied);
    for (let slot = 0; slot < (this.limits.get(lane) as number); slot++) {
      if (occupied.has(slot) || this.retired.get(lane)?.has(slot)) continue;
      occupied.add(slot);
      return { slot };
    }
    return { exhausted: `lane '${lane}' exhausted: no healthy slots` };
  }

  retire(lane: string, slot: number) {
    const retired = this.retired.get(lane) ?? new Set<number>();
    retired.add(slot);
    this.retired.set(lane, retired);
  }

  release(lane: string | undefined, slot: number | undefined) {
    if (lane !== undefined && slot !== undefined) this.occupied.get(lane)?.delete(slot);
  }
}

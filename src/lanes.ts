export class Lanes {
  private readonly retired = new Map<string, Set<number>>();
  private readonly occupied = new Map<string, Set<number>>();

  constructor(private readonly limits: Map<string, number>) {}

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

export class Lanes {
  private readonly occupied = new Map<string, Set<number>>();

  constructor(private readonly limits: Map<string, number>) {}

  capacity(lane: string) {
    const limit = this.limits.get(lane);
    if (limit === undefined) throw new Error(`unknown lane '${lane}'`);
    return limit;
  }

  allocate(lane?: string): number | undefined {
    if (lane === undefined || lane === 'solo') return;
    const occupied = this.occupied.get(lane) ?? new Set<number>();
    this.occupied.set(lane, occupied);
    for (let slot = 0; slot < this.capacity(lane); slot++) {
      if (occupied.has(slot)) continue;
      occupied.add(slot);
      return slot;
    }
    throw new Error(`lane '${lane}' has no free slot`);
  }

  release(lane: string | undefined, slot: number | undefined) {
    if (lane !== undefined && slot !== undefined) this.occupied.get(lane)?.delete(slot);
  }
}

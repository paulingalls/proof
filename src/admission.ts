import type { Lanes } from './lanes';

type Pending = { index: number; id: string; lane?: string };

export function admission(
  pending: Pending[],
  active: { lane?: string }[],
  jobs: number,
  lanes: Lanes,
  prices: Map<string, number>,
  longest: number,
) {
  if (active.some(({ lane }) => lane === 'solo')) return -1;
  const solo = pending.findIndex(({ lane }) => lane === 'solo');
  if (solo >= 0) return active.length ? -1 : solo;
  const seconds = (entry: Pending) => prices.get(entry.id) ?? longest;
  const work = new Map<string | undefined, number>();
  for (const entry of pending) {
    work.set(entry.lane, (work.get(entry.lane) ?? 0) + seconds(entry));
  }
  const pressure = ({ lane }: Pending) =>
    (work.get(lane) as number) / (lane === undefined ? jobs : lanes.capacity(lane));
  let next = -1;
  for (const [index, entry] of pending.entries()) {
    if (
      entry.lane !== undefined &&
      active.filter(({ lane }) => lane === entry.lane).length >= lanes.capacity(entry.lane)
    )
      continue;
    const previous = pending[next];
    const difference = previous ? pressure(entry) - pressure(previous) : 0;
    if (
      !previous ||
      difference > 0 ||
      (difference === 0 &&
        (seconds(entry) > seconds(previous) ||
          (seconds(entry) === seconds(previous) && entry.index < previous.index)))
    )
      next = index;
  }
  return next;
}

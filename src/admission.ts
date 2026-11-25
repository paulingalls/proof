import type { Lanes } from './lanes';

type Pending = { index: number; id: string; lane?: string };

export function admission(pending: Pending[], active: { lane?: string }[], lanes: Lanes) {
  if (active.some(({ lane }) => lane === 'solo')) return -1;
  const solo = pending.findIndex(({ lane }) => lane === 'solo');
  if (solo >= 0) return active.length ? -1 : solo;
  return pending.findIndex(
    ({ lane }) =>
      lane === undefined ||
      active.filter((entry) => entry.lane === lane).length < lanes.capacity(lane),
  );
}

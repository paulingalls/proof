type TimedResult = { task: string; outcome: string; seconds: number | null };

export const format = (value: number) => String(Number(value.toFixed(2)));

export function median(rows: TimedResult[]) {
  return midpoint(
    rows
      .filter((row) => row.outcome === 'green' && row.seconds !== null)
      .map((row) => row.seconds as number),
  );
}

export function pricesFor(rows: TimedResult[]) {
  const prices = new Map<string, number>();
  for (const id of new Set(rows.map((row) => row.task))) {
    const price = median(rows.filter((row) => row.task === id));
    if (price !== null) prices.set(id, price);
  }
  return prices;
}

export function estimate(running: string[], prices: Map<string, number>) {
  return {
    seconds: running.reduce((sum, id) => sum + (prices.get(id) ?? 0), 0),
    unpriced: running.filter((id) => !prices.has(id)),
  };
}

export function midpoint(samples: number[]) {
  samples.sort((a, b) => a - b);
  return samples.length
    ? ((samples[Math.floor(samples.length / 2)] as number) +
        (samples[Math.floor((samples.length - 1) / 2)] as number)) /
        2
    : null;
}

import { selectTasks } from './declarations';
import { generateEvents } from './generate';
import { currentTree, decide } from './plan';
import { localDay, Store } from './store';

export const statsUsage =
  'usage: proof stats [--set <name>] [--since Nd] [--by <dimension>] [--json]';

const format = (value: number) => String(Number(value.toFixed(2)));

export async function stats(args: string[]) {
  let set: string | undefined;
  let days: number | undefined;
  let by: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) {
      json = true;
      continue;
    }
    const flag = args[i];
    const value = args[++i];
    if (!value || value.startsWith('-')) throw new Error(statsUsage);
    if (flag === '--set' && set === undefined) set = value;
    else if (flag === '--since' && days === undefined && /^[1-9]\d*d$/.test(value)) {
      days = Number(value.slice(0, -1));
      if (!Number.isSafeInteger(days)) throw new Error(statsUsage);
    } else if (flag === '--by' && by === undefined) by = value;
    else throw new Error(statsUsage);
  }
  days ??= 30;
  const now = new Date();
  const boundary = (offset: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  const start = boundary(1 - days);
  const end = boundary(1);
  const previous = boundary(1 - 2 * days);
  if ([start, end, previous].some((date) => !Number.isFinite(+date))) throw new Error(statsUsage);
  const view = currentTree();
  const events = view.generate ? generateEvents(view.project, start, now) : undefined;
  const runs = events?.filter((seconds): seconds is number => seconds !== null);
  const generation =
    events && runs
      ? {
          hits: events.length - runs.length,
          runs: runs.length,
          median: midpoint(runs),
          local: true,
        }
      : undefined;
  const tasks = selectTasks(view.tasks, set);
  if (by && ![...tasks.values()].some((task) => task.dimensions?.some(([name]) => name === by)))
    throw new Error(statsUsage);
  const store = await Store.open(view.project);
  try {
    const running: string[] = [];
    for (const [id, task] of tasks) {
      const decision = await decide(
        id,
        task,
        view.tree,
        view.dirty,
        view.declaration,
        view.project,
        store,
      );
      if (decision.state === 'RUN') running.push(id);
    }
    const history = await store.history(view.project, localDay(previous), localDay(end), by);
    const results = history.results.filter((row) => tasks.has(row.task));
    const prices = new Map<string, number>();
    const lines: string[] = [];
    const reports = [];
    const inWindow = (row: (typeof results)[number]) =>
      +new Date(row.finished_at) >= +start && +new Date(row.finished_at) < +end;
    function median(rows: typeof results) {
      return midpoint(
        rows
          .filter((r) => r.outcome === 'green' && r.seconds !== null)
          .map((r) => r.seconds as number),
      );
    }
    const timing = (value: number | null) => (value === null ? 'unavailable' : `${format(value)}s`);
    for (const id of tasks.keys()) {
      const rows = results.filter((row) => row.task === id);
      const price = median(rows);
      if (price !== null) prices.set(id, price);
      const count = rows.filter(inWindow).length;
      const report: {
        task: string;
        median: number | null;
        runs: number;
        split?: {
          dimension: string;
          values: { value: string | null; median: number | null; runs: number }[];
        };
      } = { task: id, median: price, runs: count };
      reports.push(report);
      lines.push(`${id}: median ${timing(price)}; ${count} runs in ${days}d`);
      if (by && tasks.get(id)?.dimensions?.some(([name]) => name === by)) {
        const groups = new Map<string | null, typeof rows>();
        for (const row of rows.filter(inWindow)) {
          const value = row.dimension_value;
          groups.set(value, [...(groups.get(value) ?? []), row]);
        }
        const values = [...groups]
          .sort(([a], [b]) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1))
          .map(([value, rows]) => ({ value, median: median(rows), runs: rows.length }));
        report.split = { dimension: by, values };
        for (const value of values)
          lines.push(
            `  ${by}=${value.value === null ? '(no recorded value)' : JSON.stringify(value.value)}: median ${timing(value.median)}; ${value.runs} runs in ${days}d`,
          );
      }
    }
    const unpriced = running.filter((id) => !prices.has(id));
    const estimate = running.reduce((sum, id) => sum + (prices.get(id) ?? 0), 0);
    lines.push(
      `estimated ${format(estimate / 60)}m for ${running.length} RUN tasks${unpriced.length ? `; unpriced ${unpriced.length}: ${unpriced.join(', ')}` : ''}`,
    );
    if (generation)
      lines.push(
        `generate: ${generation.hits} hits, ${generation.runs} runs, median ${timing(generation.median)} in ${days}d (local to this machine)`,
      );
    function window(from: Date, to: Date) {
      let saved = 0;
      let unpriced = 0;
      for (const skip of history.skips) {
        if (!tasks.has(skip.task) || skip.day < localDay(from) || skip.day >= localDay(to))
          continue;
        const price = prices.get(skip.task);
        if (price === undefined) unpriced += skip.count;
        else saved += skip.count * price;
      }
      const actual = results
        .filter((row) => +new Date(row.finished_at) >= +from && +new Date(row.finished_at) < +to)
        .reduce((sum, row) => sum + (row.seconds ?? 0), 0);
      const total = saved + actual;
      return {
        seconds: saved,
        totalSeconds: total,
        unpricedSkips: unpriced,
        percent: total === 0 ? null : (100 * saved) / total,
      };
    }
    const current = window(start, end);
    const prior = window(previous, start);
    const percentage = (value: number | null) =>
      value === null ? 'unavailable' : `${format(value)}%`;
    lines.push(
      `saved ${format(current.seconds / 60)}m of ${format(current.totalSeconds / 60)}m in ${days}d (${percentage(current.percent)}); previous ${days}d: ${percentage(prior.percent)}${current.unpricedSkips || prior.unpricedSkips ? `; unpriced skips: ${current.unpricedSkips} current, ${prior.unpricedSkips} previous` : ''}`,
    );
    console.log(
      json
        ? JSON.stringify({
            days,
            ...(generation ? { generate: generation } : {}),
            tasks: reports,
            estimate: { seconds: estimate, runs: running.length, unpriced },
            saved: { current, previous: prior },
          })
        : lines.join('\n'),
    );
  } catch (error) {
    try {
      await store.close();
    } catch {
      /* Preserve the report failure. */
    }
    throw error;
  } finally {
    await store.close();
  }
}

function midpoint(samples: number[]) {
  samples.sort((a, b) => a - b);
  return samples.length
    ? ((samples[Math.floor(samples.length / 2)] as number) +
        (samples[Math.floor((samples.length - 1) / 2)] as number)) /
        2
    : null;
}

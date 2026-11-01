import { selectTasks } from './declarations';
import { currentTree, decide } from './plan';
import { localDay, Store } from './store';

export const statsUsage = 'usage: proof stats [--set <name>] [--since Nd]';

const format = (value: number) => String(Number(value.toFixed(2)));

export async function stats(args: string[]) {
  let set: string | undefined;
  let days: number | undefined;
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (!value || value.startsWith('-')) throw new Error(statsUsage);
    if (args[i] === '--set' && set === undefined) set = value;
    else if (args[i] === '--since' && days === undefined && /^[1-9]\d*d$/.test(value)) {
      days = Number(value.slice(0, -1));
      if (!Number.isSafeInteger(days)) throw new Error(statsUsage);
    } else throw new Error(statsUsage);
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
  const tasks = selectTasks(view.tasks, set);
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
    const history = await store.history(view.project, localDay(previous), localDay(end));
    const results = history.results.filter((row) => tasks.has(row.task));
    const prices = new Map<string, number>();
    const lines: string[] = [];
    for (const id of tasks.keys()) {
      const rows = results.filter((row) => row.task === id);
      const samples = rows
        .filter((row) => row.outcome === 'green' && row.seconds !== null)
        .map((row) => row.seconds as number)
        .sort((a, b) => a - b);
      const middle = Math.floor(samples.length / 2);
      const price = samples.length
        ? ((samples[middle] as number) +
            (samples[Math.floor((samples.length - 1) / 2)] as number)) /
          2
        : undefined;
      if (price !== undefined) prices.set(id, price);
      const count = rows.filter(
        (row) => +new Date(row.finished_at) >= +start && +new Date(row.finished_at) < +end,
      ).length;
      lines.push(
        `${id}: median ${price === undefined ? 'unavailable' : `${format(price)}s`}; ${count} runs in ${days}d`,
      );
    }
    const unpriced = running.filter((id) => !prices.has(id));
    const estimate = running.reduce((sum, id) => sum + (prices.get(id) ?? 0), 0);
    lines.push(
      `estimated ${format(estimate / 60)}m for ${running.length} RUN tasks${unpriced.length ? `; unpriced ${unpriced.length}: ${unpriced.join(', ')}` : ''}`,
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
        saved,
        total,
        unpriced,
        percent: total === 0 ? 'unavailable' : `${format((100 * saved) / total)}%`,
      };
    }
    const current = window(start, end);
    const prior = window(previous, start);
    lines.push(
      `saved ${format(current.saved / 60)}m of ${format(current.total / 60)}m in ${days}d (${current.percent}); previous ${days}d: ${prior.percent}${current.unpriced || prior.unpriced ? `; unpriced skips: ${current.unpriced} current, ${prior.unpriced} previous` : ''}`,
    );
    console.log(lines.join('\n'));
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

import { declarations } from './declarations';
import { RefTree } from './git';
import { Store } from './store';

export async function flakes(args: string[]) {
  const usage = 'usage: proof flakes [--since Nd]';
  let days = 30;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--since' || !/^[1-9]\d*d$/.test(args[1] ?? ''))
      throw new Error(usage);
    days = Number(args[1]?.slice(0, -1));
  }
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1 - days);
  if (!Number.isSafeInteger(days) || !Number.isFinite(+start)) throw new Error(usage);
  const { project } = declarations(new RefTree('HEAD'));
  const store = await Store.open(project);
  try {
    const rows = await store.flakes(project, start.toISOString());
    console.log(
      rows.length
        ? [
            'ordinary task super',
            ...rows.map((row) => `${row.ordinary} ${row.task} ${row.super}`),
          ].join('\n')
        : `no contradictions in ${days}d`,
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

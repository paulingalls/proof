import { storeConfig } from './config';
import { declarations } from './declarations';
import { dirtyPaths, RefTree } from './git';
import { serializeKey } from './key';
import { keyParts } from './key-parts';
import { postgres } from './postgres';
import { sqlite } from './sqlite';
import { type Backend, lookup } from './store';
import { initialize } from './store-schema';

export const rekeyUsage = 'usage: proof rekey [--apply]';
type Proof = { key: string; result_id: number | string; env_hashes: string | null };
type Carry = { task: string; key: string; result: number | string; identities: string };
const reasons = [
  'contested',
  'destination rejected',
  'null identities',
  'dimensions differ',
  'key differs',
  'already present',
] as const;
type Reason = (typeof reasons)[number];
const dimensions = (identities: [string, string][]) =>
  JSON.stringify(identities.filter(([name]) => name.startsWith('dimension:')));
function refusal(
  row: Proof,
  task: string,
  current: ReturnType<typeof keyParts>,
): Reason | undefined {
  if (row.env_hashes === null) return 'null identities';
  const identities = JSON.parse(row.env_hashes) as [string, string][];
  if (dimensions(identities) !== dimensions(current.env)) return 'dimensions differ';
  return serializeKey(task, current, identities) === row.key ? undefined : 'key differs';
}

export async function rekey(args: string[]) {
  if (args.length && (args.length !== 1 || args[0] !== '--apply')) throw new Error(rekeyUsage);
  if (dirtyPaths().length) throw new Error('rekey requires a clean checkout at HEAD');
  const tree = new RefTree('HEAD');
  const { tasks, project } = declarations(tree);
  const { url, excluded } = storeConfig(project);
  if (excluded) console.error(excluded);
  const backends = [sqlite(), ...(url === undefined ? [] : [postgres(url)])];
  try {
    for (const backend of backends) await initialize(backend);
    const parts = new Map([...tasks].map(([id, task]) => [id, keyParts(task, tree)]));
    const veto = new Map<string, Reason>();
    const reads = [];
    for (const backend of backends) {
      const proofs = new Map<string, Proof[]>();
      for (const [task, current] of parts) {
        if (current.reasons.length) continue;
        const key = serializeKey(task, current, current.env);
        const rows = await backend.query<Proof>(
          `SELECT p.key, p.result_id, p.env_hashes
          FROM proofs p JOIN results r ON r.id = p.result_id
          AND r.project = p.project AND r.task = p.task
          WHERE p.project = ? AND p.task = ? ORDER BY r.finished_at DESC, p.result_id DESC`,
          project,
          task,
        );
        proofs.set(task, rows);
        const identity = JSON.stringify([task, key]);
        for (const row of rows) {
          if (refusal(row, task, current)) continue;
          const proof = await lookup(project, task, row.key, backend.query, !backend.remote);
          const reds = backend.remote
            ? []
            : await backend.query(
                'SELECT 1 FROM unshared_reds WHERE project = ? AND task = ? AND key = ?',
                project,
                task,
                row.key,
              );
          if (proof?.red_commit || reds.length) veto.set(identity, 'contested');
        }
        const rejected = await backend.query(
          `SELECT 1 FROM results WHERE project = ? AND task = ?
          AND key = ? AND outcome IN ('red', 'manual') LIMIT 1`,
          project,
          task,
          key,
        );
        if (rejected.length && !veto.has(identity)) veto.set(identity, 'destination rejected');
      }
      reads.push({ backend, proofs });
    }
    for (const { backend, proofs } of reads) {
      const skipped = new Map<Reason, number>(reasons.map((reason) => [reason, 0]));
      const carries: Carry[] = [];
      let unchanged = 0;
      let undecidable = 0;
      for (const [task, current] of parts) {
        if (current.reasons.length) {
          undecidable++;
          continue;
        }
        const key = serializeKey(task, current, current.env);
        const rows = proofs.get(task) ?? [];
        let present = rows.some((row) => row.key === key);
        for (const row of rows) {
          if (row.key === key) {
            unchanged++;
            continue;
          }
          const reason =
            refusal(row, task, current) ??
            veto.get(JSON.stringify([task, key])) ??
            (present ? 'already present' : undefined);
          if (reason) skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
          else {
            carries.push({
              task,
              key,
              result: row.result_id,
              identities: JSON.stringify(current.env),
            });
            present = true;
          }
        }
      }
      const carried = args.length ? await apply(backend, project, carries) : carries.length;
      const count = [...skipped.values()].reduce((sum, value) => sum + value, 0);
      console.log(
        `${backend.remote ? 'shared' : 'local'}: ${args.length ? 'carried' : 'would carry'} ${carried}; skipped proofs ${count}; unchanged ${unchanged}; undecidable tasks ${undecidable}`,
      );
      for (const [reason, count] of skipped) console.log(`  ${reason}: ${count}`);
    }
  } finally {
    await Promise.all(backends.map((backend) => backend.close()));
  }
}

async function apply(backend: Backend, project: string, carries: Carry[]) {
  return backend.transaction('proof:rekey', async (query) => {
    let count = 0;
    for (const carry of carries) {
      const rows = await query(
        `INSERT INTO proofs (project, task, key, result_id, env_hashes)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT (project, task, key) DO NOTHING RETURNING key`,
        project,
        carry.task,
        carry.key,
        carry.result,
        carry.identities,
      );
      count += rows.length;
    }
    return count;
  });
}

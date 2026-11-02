import { storeConfig } from './config';
import { declarations, type Task } from './declarations';
import { dirtyPaths, hasCommit, RefTree } from './git';
import { selection, serializeKey } from './key';
import { keyParts } from './key-parts';
import { postgres } from './postgres';
import { sqlite } from './sqlite';
import { type Backend, lookup } from './store';
import { initialize } from './store-schema';
import { manifestMembers } from './workspaces';

export const rekeyUsage = 'usage: proof rekey [--apply]';
type Proof = { key: string; result_id: number | string; env_hashes: string | null; commit: string };
type Carry = {
  task: string;
  key: string;
  result: number | string;
  identities: string;
  commit: string;
  added: string[];
};
const reasons = [
  'commit unavailable',
  'declarations unavailable',
  'declaration differs',
  'input deleted',
  'input changed',
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
  if (dirtyPaths().length) {
    console.log('  dirty tree: 1');
    throw new Error('rekey requires a clean checkout at HEAD');
  }
  const tree = new RefTree('HEAD');
  const { tasks, project } = declarations(tree);
  const { url, excluded } = storeConfig(project);
  if (excluded) console.error(excluded);
  const local = sqlite();
  const backends = [local, ...(url === undefined ? [] : [postgres(url)])];
  try {
    for (const backend of backends) await initialize(backend);
    const parts = new Map([...tasks].map(([id, task]) => [id, keyParts(task, tree)]));
    const historical = historicalCarry(tree);
    const veto = new Map<string, Reason>();
    const reads = [];
    for (const backend of backends) {
      const proofs = new Map<string, Proof[]>();
      const decisions = new Map<Proof, { reason?: Reason; added?: string[] }>();
      for (const [task, current] of parts) {
        if (current.reasons.length) continue;
        const key = serializeKey(task, current, current.env);
        const rows = await backend.query<Proof>(
          `SELECT p.key, p.result_id, p.env_hashes, r."commit" AS "commit"
          FROM proofs p JOIN results r ON r.id = p.result_id
          AND r.project = p.project AND r.task = p.task
          WHERE p.project = ? AND p.task = ? ORDER BY r.finished_at DESC, p.result_id DESC`,
          project,
          task,
        );
        proofs.set(task, rows);
        const identity = JSON.stringify([task, key]);
        const candidate = rows.find(
          (row) =>
            row.env_hashes !== null &&
            dimensions(JSON.parse(row.env_hashes)) === dimensions(current.env),
        );
        const declared = tasks.get(task) as Task;
        for (const row of rows) {
          let decision: { reason?: Reason; added?: string[] } = {
            reason: refusal(row, task, current),
          };
          if (
            decision.reason === 'key differs' &&
            declared.carry === true &&
            row === candidate &&
            !rows.some((row) => row.key === key)
          ) {
            decision = historical(row.commit, task, declared, current);
          }
          decisions.set(row, decision);
          if (decision.reason) continue;
          const proof = await lookup(project, task, row.key, backend.query, !backend.remote);
          const reds = await local.query(
            'SELECT 1 FROM unshared_reds WHERE project = ? AND task = ? AND key = ?',
            project,
            task,
            row.key,
          );
          const contradictions =
            declared.carry === true
              ? await backend.query(
                  'SELECT 1 FROM contradictions WHERE green_result = ? LIMIT 1',
                  row.result_id,
                )
              : [];
          if (proof?.red_commit || reds.length || contradictions.length)
            veto.set(identity, 'contested');
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
      reads.push({ backend, proofs, decisions });
    }
    for (const { backend, proofs, decisions } of reads) {
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
            decisions.get(row)?.reason ??
            veto.get(JSON.stringify([task, key])) ??
            (present ? 'already present' : undefined);
          if (reason) skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
          else {
            carries.push({
              task,
              key,
              result: row.result_id,
              identities: JSON.stringify(current.env),
              commit: row.commit,
              added: decisions.get(row)?.added ?? [],
            });
            present = true;
          }
        }
      }
      const published = args.length ? await apply(backend, project, carries) : carries;
      for (const carry of published) {
        console.log(
          `  ${carry.task}: ${args.length ? 'carried' : 'would carry'} from ${carry.commit}`,
        );
        for (const path of carry.added) console.log(`    added input ${path}`);
      }
      const carried = published.length;
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
    const published: Carry[] = [];
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
      if (rows.length) published.push(carry);
    }
    return published;
  });
}

type HistoricalRefusal =
  | 'commit unavailable'
  | 'declarations unavailable'
  | 'declaration differs'
  | 'input deleted'
  | 'input changed';

function historicalCarry(tree: RefTree) {
  const history = new Map<
    string,
    { tree: RefTree; declarations: ReturnType<typeof declarations> } | HistoricalRefusal
  >();
  const diagnosed = new Set<string>();
  function diagnostic(commit: string, error: unknown) {
    if (diagnosed.has(commit)) return;
    diagnosed.add(commit);
    console.error(`rekey: ${commit}: declarations unavailable: ${error}`);
  }
  return (commit: string, id: string, task: Task, current: ReturnType<typeof keyParts>) => {
    if (!history.has(commit)) {
      if (!hasCommit(commit)) history.set(commit, 'commit unavailable');
      else {
        try {
          const previous = new RefTree(commit);
          history.set(commit, { tree: previous, declarations: declarations(previous) });
        } catch (error) {
          diagnostic(commit, error);
          history.set(commit, 'declarations unavailable');
        }
      }
    }
    const old = history.get(commit);
    if (old === undefined) throw new Error(`missing history for ${commit}`);
    if (typeof old === 'string') return { reason: old };
    const previous = old.tree;
    try {
      const before = old.declarations.tasks.get(id);
      if (!before) throw new Error(`missing task '${id}'`);
      const parts = keyParts(before, previous, true);
      if (parts.reasons.length) throw new Error(parts.reasons.join('; '));
      if (parts.declarationHash !== current.declarationHash)
        return { reason: 'declaration differs' as const };
      const paths = selection(before, previous);
      if ([...paths].some((path) => !tree.files.has(path)))
        return { reason: 'input deleted' as const };
      for (const path of current.selection.paths) {
        if (current.selection.manifests.includes(path)) continue;
        const a = tree.entry(path);
        const b = previous.entry(path);
        if (!b.mode || a.mode !== b.mode || a.blob !== b.blob)
          return { reason: 'input changed' as const };
      }
      const projected = {
        ...task,
        unkeyed: undefined,
        inputs: [
          ...task.inputs.filter((input) => typeof input !== 'string' && 'path' in input),
          ...current.selection.manifests.map((path) => ({ path, json: manifestMembers })),
        ],
      };
      const now = keyParts(projected, tree, true);
      const then = keyParts(projected, previous, true);
      if (then.reasons.length || JSON.stringify(now.members) !== JSON.stringify(then.members))
        return { reason: 'input changed' as const };
      return { added: [...selection(task, tree)].filter((path) => !paths.has(path)).sort() };
    } catch (error) {
      diagnostic(commit, error);
      return { reason: 'declarations unavailable' as const };
    }
  };
}

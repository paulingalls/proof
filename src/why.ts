import { declarations } from './declarations';
import { hasCommit, RefTree, WorkingTree } from './git';
import { keyParts } from './key-parts';
import { currentTree, decide, renderDecision, STAGED_SUFFIX } from './plan';
import { Store } from './store';

export async function why(args: string[]) {
  const [id] = args;
  if (args.length !== 1 || !id || id.startsWith('-')) throw new Error('usage: proof why <task>');
  const view = currentTree();
  const task = view.tasks.get(id);
  if (!task) throw new Error(`undeclared task '${id}'`);
  const store = await Store.open();
  try {
    console.log(
      renderDecision(
        await decide(id, task, view.tree, view.dirty, view.declaration, view.project, store),
      ),
    );
    const parts = keyParts(task, new WorkingTree(view.tree, view.dirty));
    for (const [path, mode, blob] of parts.files) console.log(`file ${path} ${mode} ${blob}`);
    for (const [path, mode, member, hash] of parts.members)
      console.log(`member ${path} ${member} ${mode} ${hash}`);
    for (const [name] of parts.env) console.log(`env ${name}`);
    console.log(`declaration ${parts.declarationHash}`);
    for (const reason of parts.reasons) console.log(`undecidable: ${reason}`);
    const proof = await store.newestProof(view.project, id);
    if (!proof) {
      console.log('no proof for this task');
      return;
    }
    console.log(`comparison: ${proof.commit} on ${proof.host} ${proof.finished_at}`);
    if (proof.commit.endsWith(STAGED_SUFFIX)) {
      console.log('historical comparison unavailable: staged proof');
      return;
    }
    if (!hasCommit(proof.commit)) {
      console.log(`proof commit unavailable: ${proof.commit}`);
      return;
    }
    const tree = new RefTree(proof.commit);
    const previous = declarations(tree).tasks.get(id);
    if (!previous) throw new Error(`proof commit: undeclared task '${id}'`);
    const before = keyParts(previous, tree, true);
    if (proof.env_hashes === null) console.log('env comparison unavailable');
    else before.env = JSON.parse(proof.env_hashes) as [string, string][];
    for (const reason of before.reasons) console.log(`proof undecidable: ${reason}`);
    const differences = compareParts(before, parts, proof.env_hashes !== null);
    console.log(
      differences.length
        ? differences.join('\n')
        : before.reasons.length || parts.reasons.length || proof.env_hashes === null
          ? 'no comparable inputs changed'
          : 'no inputs changed',
    );
  } finally {
    await store.close();
  }
}

type Parts = ReturnType<typeof keyParts>;
function compareParts(before: Parts, after: Parts, compareEnv: boolean) {
  const differences: string[] = [];
  const oldFiles = new Map(before.files.map(([path, mode, hash]) => [path, [mode, hash]]));
  const newFiles = new Map(after.files.map(([path, mode, hash]) => [path, [mode, hash]]));
  for (const path of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()) {
    const old = oldFiles.get(path);
    const current = newFiles.get(path);
    if (
      !old &&
      ((!before.selection.reason && !before.selection.paths.has(path)) ||
        !before.tree.files.has(path))
    )
      differences.push(`added file ${path}`);
    else if (
      !current &&
      ((!after.selection.reason && !after.selection.paths.has(path)) || !after.tree.files.has(path))
    )
      differences.push(`removed file ${path}`);
    else if (old && current && JSON.stringify(old) !== JSON.stringify(current))
      differences.push(`changed file ${path}`);
  }
  const oldMembers = new Map(
    before.members.map(([path, mode, member, hash]) => [
      JSON.stringify([path, member]),
      [mode, hash],
    ]),
  );
  const newMembers = new Map(
    after.members.map(([path, mode, member, hash]) => [
      JSON.stringify([path, member]),
      [mode, hash],
    ]),
  );
  for (const id of [...new Set([...oldMembers.keys(), ...newMembers.keys()])].sort()) {
    const [path, member] = JSON.parse(id) as [string, string];
    const old = oldMembers.get(id);
    const current = newMembers.get(id);
    if (
      !old &&
      ((!before.selection.reason && !before.projections.has(id)) || !before.tree.files.has(path))
    )
      differences.push(`added member ${path} ${member}`);
    else if (
      !current &&
      ((!after.selection.reason && !after.projections.has(id)) || !after.tree.files.has(path))
    )
      differences.push(`removed member ${path} ${member}`);
    else if (old && current && JSON.stringify(old) !== JSON.stringify(current))
      differences.push(`changed member ${path} ${member}`);
  }
  const oldEnv = new Map(before.env);
  const newEnv = new Map(after.env);
  for (const name of [...new Set([...oldEnv.keys(), ...newEnv.keys()])].sort())
    if (compareEnv && oldEnv.get(name) !== newEnv.get(name))
      differences.push(`changed env ${name}`);
  if (before.declarationHash !== after.declarationHash) differences.push('declaration changed');
  return differences;
}

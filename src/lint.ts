import { declarations } from './declarations';
import { RefTree } from './git';
import { matching, select } from './key';

export function lint() {
  const tree = RefTree.index();
  const { tasks, coverage, exempt } = declarations(tree);
  const findings: string[] = [];
  for (const [id, task] of tasks) {
    for (const input of task.inputs) {
      if (typeof input === 'string') {
        if (!input.startsWith('!') && matching(tree, input).next().done)
          findings.push(`task '${id}': unmatched input '${input}'`);
      } else {
        if ('dotenv' in input) continue;
        const path =
          'path' in input ? input.path : 'maestro' in input ? input.maestro : input['imports-of'];
        if (!tree.files.has(path)) findings.push(`task '${id}': missing input '${path}'`);
      }
    }
  }
  const covered = new Set<string>();
  for (const pattern of coverage) {
    let matched = false;
    for (const path of matching(tree, pattern)) {
      matched = true;
      covered.add(path);
    }
    if (!matched) findings.push(`coverage: unmatched pattern '${pattern}'`);
  }
  const absentExempt = Object.keys(exempt).filter((path) => !tree.files.has(path));
  const selections = new Map<string, Set<string>>();
  const owned = new Set<string>();
  for (const [id, task] of tasks) {
    const paths = select(task, tree, absentExempt).paths;
    for (const input of task.inputs) {
      if (typeof input !== 'string' && 'path' in input) paths.add(input.path);
    }
    selections.set(id, paths);
    for (const path of paths) owned.add(path);
  }
  for (const path of covered) {
    if (!owned.has(path) && !Object.hasOwn(exempt, path)) findings.push(`unowned '${path}'`);
  }
  for (const path of Object.keys(exempt)) {
    if (!tree.files.has(path)) findings.push(`exempt '${path}': no tracked file`);
    for (const [id, paths] of selections) {
      if (paths.has(path)) findings.push(`exempt '${path}': selected by task '${id}'`);
    }
  }
  return findings;
}

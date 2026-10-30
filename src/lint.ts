import { declarations } from './declarations';
import { RefTree } from './git';
import { matching, selects } from './key';

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
        const path = 'path' in input ? input.path : input['imports-of'];
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
  for (const path of covered) {
    if (
      ![...tasks.values()].some((task) => selects(task, path, tree)) &&
      !Object.hasOwn(exempt, path)
    )
      findings.push(`unowned '${path}'`);
  }
  for (const path of Object.keys(exempt)) {
    if (!tree.files.has(path)) findings.push(`exempt '${path}': no tracked file`);
    for (const [id, task] of tasks) {
      if (selects(task, path, tree)) findings.push(`exempt '${path}': selected by task '${id}'`);
    }
  }
  return findings;
}

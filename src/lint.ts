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
      } else if (!tree.files.has(input.path)) {
        findings.push(`task '${id}': missing input '${input.path}'`);
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
    if (![...tasks.values()].some((task) => selects(task, path)) && !Object.hasOwn(exempt, path))
      findings.push(`unowned '${path}'`);
  }
  return findings;
}

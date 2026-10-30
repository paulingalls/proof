import { declarations } from './declarations';
import { RefTree } from './git';
import { matching } from './key';

export function lint() {
  const tree = RefTree.index();
  const { tasks } = declarations(tree);
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
  return findings;
}

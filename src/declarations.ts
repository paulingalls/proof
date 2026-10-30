import type { RefTree } from './git';

export type Task = { run: string; inputs: string[] };

export function declarations(tree: RefTree): Map<string, Task> {
  const root = Bun.YAML.parse(tree.read('proof.yaml')) as { tasks: Record<string, Task> };
  return new Map(Object.entries(root.tasks));
}

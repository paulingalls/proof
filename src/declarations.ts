import type { RefTree } from './git';

export type Task = { run: string; inputs: string[] };

export function declarations(tree: RefTree): Map<string, Task> {
  const root = Bun.YAML.parse(tree.read('proof.yaml')) as {
    inputs?: Record<string, string[]>;
    tasks: Record<string, Task>;
  };
  function expand(patterns: string[], stack: string[] = []): string[] {
    return patterns.flatMap((pattern) => {
      if (!pattern.startsWith('$')) return [pattern];
      const name = pattern.slice(1);
      const set = root.inputs?.[name];
      if (!set) throw new Error(`unknown input set '${name}'`);
      if (stack.includes(name)) throw new Error(`cyclic input set '${name}'`);
      return expand(set, [...stack, name]);
    });
  }
  return new Map(
    Object.entries(root.tasks).map(([id, task]) => [id, { ...task, inputs: expand(task.inputs) }]),
  );
}

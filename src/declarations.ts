import type { RefTree } from './git';

export type Task = { run: string; inputs: string[] };

export function declarations(tree: RefTree): Map<string, Task> {
  const root = Bun.YAML.parse(tree.read('proof.yaml')) as {
    include?: string;
    inputs?: Record<string, string[]>;
    tasks: Record<string, Task>;
  };
  if (root.include) {
    const matches = [...tree.files.keys()]
      .filter((path) => new Bun.Glob(root.include as string).match(path))
      .sort();
    if (!matches.length) throw new Error(`unmatched include '${root.include}'`);
    for (const path of matches) {
      const fragment = Bun.YAML.parse(tree.read(path)) as typeof root;
      root.inputs = { ...root.inputs, ...fragment.inputs };
      root.tasks = { ...root.tasks, ...fragment.tasks };
    }
  }
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

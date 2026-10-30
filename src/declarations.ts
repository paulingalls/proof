import type { RefTree } from './git';
import { refuseDuplicateKeys } from './yaml-keys';

export type Task = { run: string; inputs: string[] };

export function mapping(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context}: expected a mapping`);
  }
  return value as Record<string, unknown>;
}

export function fields(value: Record<string, unknown>, allowed: string[], context: string) {
  for (const name of Object.keys(value)) {
    if (!allowed.includes(name)) throw new Error(`${context}: unknown field '${name}'`);
  }
}

export function text(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${context}: expected a nonempty string`);
  }
  return value;
}

function patterns(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || !value.length) {
    throw new Error(`${context}: inputs must be a nonempty string list`);
  }
  return value.map((entry, index) =>
    text(entry, `${context} input ${index + 1} (quote '!' patterns)`),
  );
}

export function declarations(tree: RefTree) {
  const sets = new Map<string, string[]>();
  const tasks = new Map<string, Task>();
  const contexts = new Map<string, string>();
  function read(path: string, root: boolean) {
    const context = `ref '${tree.ref}' ${path}`;
    let parsed: unknown;
    try {
      const source = tree.read(path);
      parsed = Bun.YAML.parse(source);
      refuseDuplicateKeys(source);
    } catch (error) {
      throw new Error(`${context}: ${error}`);
    }
    const doc = mapping(parsed, context);
    fields(
      doc,
      root ? ['version', 'project', 'inputs', 'tasks', 'include'] : ['inputs', 'tasks'],
      context,
    );
    if (root) {
      if (doc.version !== 1) throw new Error(`${context}: version must be 1`);
      text(doc.project, `${context} project`);
    }
    for (const [name, value] of Object.entries(
      mapping('inputs' in doc ? doc.inputs : {}, `${context} inputs`),
    )) {
      text(name, `${context} input set name`);
      if (sets.has(name)) throw new Error(`${context}: duplicate input set '${name}'`);
      sets.set(name, patterns(value, `${context} set '${name}'`));
      contexts.set(name, `${context} set '${name}'`);
    }
    for (const [id, value] of Object.entries(
      mapping('tasks' in doc ? doc.tasks : {}, `${context} tasks`),
    )) {
      text(id, `${context} task id`);
      const label = `${context} task '${id}'`;
      if (tasks.has(id)) throw new Error(`${label}: duplicate task '${id}'`);
      const task = mapping(value, label);
      fields(task, ['run', 'inputs'], label);
      tasks.set(id, {
        run: text(task.run, `${label} run`),
        inputs: patterns(task.inputs, label),
      });
    }
    return doc;
  }
  const root = read('proof.yaml', true);
  if ('include' in root) {
    const pattern = text(root.include, 'proof.yaml include');
    const glob = new Bun.Glob(pattern);
    const paths = [...tree.files.keys()].filter((path) => glob.match(path)).sort();
    if (!paths.length) throw new Error(`ref '${tree.ref}': unmatched include '${pattern}'`);
    for (const path of paths) read(path, false);
  }
  function expand(inputs: string[], context: string, stack: string[] = []): string[] {
    return inputs.flatMap((pattern) => {
      if (!pattern.startsWith('$')) return [pattern];
      const name = pattern.slice(1);
      const set = sets.get(name);
      if (!set) throw new Error(`${context}: unknown input set '${name}'`);
      if (stack.includes(name)) throw new Error(`${context}: cyclic input set '${name}'`);
      return expand(set, context, [...stack, name]);
    });
  }
  for (const [name, set] of sets) expand(set, contexts.get(name) as string, [name]);
  for (const [id, task] of tasks) {
    task.inputs = expand(task.inputs, `ref '${tree.ref}' task '${id}'`);
  }
  return {
    project: text(root.project, 'proof.yaml project'),
    tasks,
    include: 'include' in root ? text(root.include, 'proof.yaml include') : undefined,
  };
}

export function declarationPaths(include: string | undefined) {
  return include === undefined ? ['proof.yaml'] : ['proof.yaml', include];
}

export function dirtyDeclaration(dirty: string[], include: string | undefined) {
  return dirty.find(
    (path) => path === 'proof.yaml' || (include !== undefined && new Bun.Glob(include).match(path)),
  );
}

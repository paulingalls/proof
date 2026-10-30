import { readFileSync } from 'node:fs';
import { dirtyPaths, type RefTree } from './git';
import { scope } from './key';
import { refuseDuplicateKeys } from './yaml-keys';

export type Input = string | { path: string; json: string[] };
export type Task = { run: string; inputs: Input[]; env?: string[] };

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

function patterns(value: unknown, context: string): Input[] {
  if (!Array.isArray(value) || !value.length) {
    throw new Error(`${context}: inputs must be a nonempty list`);
  }
  return value.map((entry, index) => {
    const label = `${context} input ${index + 1} (quote '!' patterns)`;
    if (!entry || typeof entry !== 'object') return text(entry, label);
    const projection = mapping(entry, label);
    fields(projection, ['path', 'json'], label);
    if (!Array.isArray(projection.json) || !projection.json.length) {
      throw new Error(`${label}: json must be a nonempty member list`);
    }
    return {
      path: text(projection.path, `${label} path`),
      json: projection.json.map((member) => text(member, `${label} json member`)),
    };
  });
}

export function declarations(tree: RefTree, working = false) {
  const sets = new Map<string, Input[]>();
  const tasks = new Map<string, Task>();
  const contexts = new Map<string, string>();
  function read(path: string, root: boolean) {
    const context = `ref '${tree.ref}' ${path}`;
    let parsed: unknown;
    try {
      const source = working ? readFileSync(path, 'utf8') : tree.read(path);
      parsed = Bun.YAML.parse(source);
      refuseDuplicateKeys(source);
    } catch (error) {
      throw new Error(`${context}: ${error}`);
    }
    const doc = mapping(parsed, context);
    fields(
      doc,
      root
        ? ['version', 'project', 'inputs', 'tasks', 'include', 'coverage', 'exempt']
        : ['inputs', 'tasks'],
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
      fields(task, ['run', 'inputs', 'env'], label);
      let env: string[] | undefined;
      if ('env' in task) {
        if (!Array.isArray(task.env)) throw new Error(`${label}: env must be a list`);
        env = [...new Set(task.env.map((name) => text(name, `${label} env name`)))].sort();
      }
      tasks.set(id, {
        run: text(task.run, `${label} run`),
        inputs: patterns(task.inputs, label),
        env,
      });
    }
    return doc;
  }
  const root = read('proof.yaml', true);
  if ('include' in root) {
    const pattern = text(root.include, 'proof.yaml include');
    const glob = new Bun.Glob(pattern);
    const available = new Set([
      ...tree.files.keys(),
      ...(working ? dirtyPaths(scope([], [pattern])) : []),
    ]);
    const paths = [...available].filter((path) => glob.match(path)).sort();
    if (!paths.length) throw new Error(`ref '${tree.ref}': unmatched include '${pattern}'`);
    for (const path of paths) read(path, false);
  }
  function expand(inputs: Input[], context: string, stack: string[] = []): Input[] {
    return inputs.flatMap((pattern) => {
      if (typeof pattern !== 'string' || !pattern.startsWith('$')) return [pattern];
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
  const context = `ref '${tree.ref}' proof.yaml`;
  const coverage: string[] = [];
  if ('coverage' in root) {
    if (!Array.isArray(root.coverage)) throw new Error(`${context} coverage: expected a list`);
    coverage.push(...root.coverage.map((pattern) => text(pattern, `${context} coverage pattern`)));
  }
  const exempt = Object.fromEntries(
    Object.entries(mapping('exempt' in root ? root.exempt : {}, `${context} exempt`)).map(
      ([path, reason]) => [
        text(path, `${context} exempt path`),
        text(reason, `${context} exempt '${path}' reason`),
      ],
    ),
  );
  return {
    project: text(root.project, 'proof.yaml project'),
    tasks,
    coverage,
    exempt,
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

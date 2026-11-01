import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { type Generator, generate } from './generate';
import { dirtyPaths, type RefTree } from './git';
import { filePatterns, resolveUnkeyed } from './unkeyed';
import { refuseDuplicateKeys } from './yaml-keys';

export type Input =
  | string
  | { path: string; json: string[] }
  | { path: string; 'dotenv-keys': true }
  | { dotenv: string; exclude?: string[] }
  | { 'imports-of': string }
  | { maestro: string };
export type Provider = { start: string; stop?: string; lane?: string };
export type Task = {
  run: string;
  inputs: Input[];
  env?: string[];
  keyed?: string[];
  unkeyed?: Set<string>;
  dimensions?: [string, string][];
  links?: string[];
  needs?: string[];
  sets?: string[];
  lane?: string;
};

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
    if ('maestro' in projection) {
      fields(projection, ['maestro'], label);
      return { maestro: text(projection.maestro, label) };
    }
    if ('imports-of' in projection) {
      fields(projection, ['imports-of'], label);
      return { 'imports-of': text(projection['imports-of'], label) };
    }
    if ('dotenv' in projection) {
      fields(projection, ['dotenv', 'exclude'], label);
      const path = text(projection.dotenv, `${label} dotenv`);
      if (path === 'dimension') throw new Error(`${label}: reserved dotenv '${path}'`);
      if (isAbsolute(path) || path.split('/').some((p) => ['', '.', '..', '.git'].includes(p)))
        throw new Error(`${label}: unsafe dotenv '${path}'`);
      if (
        'exclude' in projection &&
        (!Array.isArray(projection.exclude) || !projection.exclude.length)
      )
        throw new Error(`${label}: exclude must be a nonempty list`);
      const exclude = (projection.exclude as unknown[] | undefined)?.map((name) =>
        text(name, `${label} exclude name`),
      );
      return { dotenv: path, ...(exclude ? { exclude: [...new Set(exclude)].sort() } : {}) };
    }
    fields(projection, ['path', 'json', 'dotenv-keys'], label);
    if ('dotenv-keys' in projection) {
      if ('json' in projection) throw new Error(`${label}: use json or dotenv-keys, not both`);
      if (projection['dotenv-keys'] !== true) throw new Error(`${label}: dotenv-keys must be true`);
      return { path: text(projection.path, `${label} path`), 'dotenv-keys': true };
    }
    if (!Array.isArray(projection.json) || !projection.json.length) {
      throw new Error(`${label}: json must be a nonempty member list`);
    }
    return {
      path: text(projection.path, `${label} path`),
      json: projection.json.map((member) => text(member, `${label} json member`)),
    };
  });
}

function linkList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label}: links must be a list`);
  return [
    ...new Set(
      value.map((value) => {
        const path = text(value, `${label} link '${String(value)}'`);
        if (isAbsolute(path) || path.split('/').some((p) => ['', '.', '..', '.git'].includes(p)))
          throw new Error(`${label}: unsafe link '${path}'`);
        return path;
      }),
    ),
  ].sort();
}

export function declarations(tree: RefTree, working = false) {
  const sets = new Map<string, Input[]>();
  const tasks = new Map<string, Task>();
  const contexts = new Map<string, string>();
  const requested = new Map<string, string[]>();
  const unkeyed: unknown[] = [];
  function read(path: string, root: boolean) {
    const context = `ref '${tree.ref}' ${path}`;
    return load(working ? readFileSync(path, 'utf8') : tree.read(path), context, root);
  }
  function load(source: string, context: string, root: boolean) {
    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(source);
      refuseDuplicateKeys(source);
    } catch (error) {
      throw new Error(`${context}: ${error}`);
    }
    const doc = mapping(parsed, context);
    fields(
      doc,
      root
        ? [
            'generate',
            'version',
            'project',
            'inputs',
            'tasks',
            'include',
            'coverage',
            'exempt',
            'providers',
            'lanes',
            'dimensions',
            'unkeyed',
          ]
        : ['inputs', 'tasks', 'unkeyed'],
      context,
    );
    if ('unkeyed' in doc) unkeyed.push(...filePatterns(doc.unkeyed, `${context} unkeyed`));
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
      fields(
        task,
        ['run', 'inputs', 'env', 'links', 'needs', 'sets', 'lane', 'dimensions', 'keyed'],
        label,
      );
      if ('dimensions' in task) {
        if (!Array.isArray(task.dimensions)) throw new Error(`${label}: dimensions must be a list`);
        requested.set(
          id,
          [...new Set(task.dimensions.map((name) => text(name, `${label} dimension name`)))].sort(),
        );
      }
      let membership: string[] | undefined;
      if ('sets' in task) {
        if (!Array.isArray(task.sets)) throw new Error(`${label}: sets must be a list`);
        membership = [...new Set(task.sets.map((name) => text(name, `${label} set name`)))];
      }
      let needs: string[] | undefined;
      if ('needs' in task) {
        if (!Array.isArray(task.needs)) throw new Error(`${label}: needs must be a list`);
        needs = [...new Set(task.needs.map((name) => text(name, `${label} provider name`)))];
      }
      let env: string[] | undefined;
      if ('env' in task) {
        if (!Array.isArray(task.env)) throw new Error(`${label}: env must be a list`);
        env = [...new Set(task.env.map((name) => text(name, `${label} env name`)))].sort();
      }
      if (env?.some((name) => name.includes(':')))
        throw new Error(`${label}: env name must not contain ':'`);
      if (env?.includes('PROOF_LANE_SLOT'))
        throw new Error(`${label}: PROOF_LANE_SLOT is reserved`);
      const links = 'links' in task ? linkList(task.links, label) : undefined;
      tasks.set(id, {
        run: text(task.run, `${label} run`),
        inputs: patterns(task.inputs, label),
        env,
        keyed: 'keyed' in task ? filePatterns(task.keyed, `${label} keyed`) : undefined,
        links,
        needs,
        sets: membership,
        lane: 'lane' in task ? text(task.lane, `${label} lane`) : undefined,
      });
    }
    return doc;
  }
  const root = read('proof.yaml', true);
  const dimensions = new Map<string, string>();
  for (const [name, command] of Object.entries(
    mapping('dimensions' in root ? root.dimensions : {}, 'proof.yaml dimensions'),
  )) {
    const label = `proof.yaml dimension '${text(name, 'dimension name')}'`;
    if (name.includes(':')) throw new Error(`${label}: name must not contain ':'`);
    dimensions.set(name, text(command, label));
  }
  const lanes = new Map<string, number>();
  for (const [name, limit] of Object.entries(
    mapping('lanes' in root ? root.lanes : {}, 'proof.yaml lanes'),
  )) {
    const label = `proof.yaml lane '${text(name, 'lane name')}'`;
    if (name === 'solo') throw new Error(`${label}: reserved`);
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1)
      throw new Error(`${label}: expected a positive safe integer`);
    lanes.set(name, limit);
  }
  const providers = new Map<string, Provider>();
  for (const [name, value] of Object.entries(
    mapping('providers' in root ? root.providers : {}, 'proof.yaml providers'),
  )) {
    const label = `proof.yaml provider '${text(name, 'provider name')}'`;
    const provider = mapping(value, label);
    fields(provider, ['start', 'stop', 'lane'], label);
    const lane = 'lane' in provider ? text(provider.lane, `${label} lane`) : undefined;
    if (lane !== undefined && !lanes.has(lane)) throw new Error(`${label}: unknown lane '${lane}'`);
    providers.set(name, {
      start: text(provider.start, `${label} start`),
      lane,
      ...('stop' in provider ? { stop: text(provider.stop, `${label} stop`) } : {}),
    });
  }
  if ('include' in root) {
    const pattern = text(root.include, 'proof.yaml include');
    const glob = new Bun.Glob(pattern);
    const available = new Set([...tree.files.keys(), ...(working ? dirtyPaths() : [])]);
    const paths = [...available]
      .filter((path) => glob.match(path) && (!working || existsSync(path)))
      .sort();
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
  let generator: Generator | undefined;
  let generated: [string, string][] = [];
  if ('generate' in root) {
    const label = 'proof.yaml generate';
    const value = mapping(root.generate, label);
    fields(value, ['run', 'inputs', 'links'], label);
    generator = {
      run: text(value.run, `${label} run`),
      inputs: expand(patterns(value.inputs, label), label),
      links: 'links' in value ? linkList(value.links, label) : undefined,
    };
    generated = generate(
      generator,
      tree,
      working ? dirtyPaths() : [],
      text(root.project, 'project'),
    );
    for (const [name, source] of generated) load(source, `${label}: ${name}`, false);
  }
  for (const [name, set] of sets) expand(set, contexts.get(name) as string, [name]);
  for (const [id, task] of tasks) {
    task.dimensions = requested.get(id)?.map((name) => {
      const command = dimensions.get(name);
      if (command === undefined) throw new Error(`task '${id}': unknown dimension '${name}'`);
      return [name, command];
    });
    if (task.lane !== undefined && task.lane !== 'solo' && !lanes.has(task.lane))
      throw new Error(`task '${id}': unknown lane '${task.lane}'`);
    task.inputs = expand(task.inputs, `ref '${tree.ref}' task '${id}'`);
    for (const name of task.needs ?? []) {
      const provider = providers.get(name);
      if (!provider) throw new Error(`task '${id}': unknown provider '${name}'`);
      if (provider.lane !== undefined && provider.lane !== task.lane)
        throw new Error(`task '${id}': provider '${name}' requires lane '${provider.lane}'`);
    }
  }
  resolveUnkeyed(unkeyed, tasks, tree, working);
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
    generate: generator,
    generated,
    providers,
    dimensions,
    lanes,
    coverage,
    exempt,
    include: 'include' in root ? text(root.include, 'proof.yaml include') : undefined,
  };
}

export function dirtyDeclaration(dirty: string[], include: string | undefined) {
  return dirty.find(
    (path) => path === 'proof.yaml' || (include !== undefined && new Bun.Glob(include).match(path)),
  );
}

export function selectTasks(tasks: Map<string, Task>, set?: string) {
  if (set === undefined) return tasks;
  const known = [...new Set([...tasks.values()].flatMap((task) => task.sets ?? []))].sort();
  if (!known.includes(set))
    throw new Error(`unknown task set '${set}'; known sets: ${known.join(', ') || 'none'}`);
  return new Map([...tasks].filter(([, task]) => task.sets?.includes(set)));
}

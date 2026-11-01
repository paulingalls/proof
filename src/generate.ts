import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statePath } from './config';
import type { Task } from './declarations';
import { type RefTree, WorkingTree } from './git';
import { source } from './imports';
import { select } from './key';
import { Capture, logSuffix } from './logs';
import { BASE_ENV } from './providers';
import { inspectLinks, Sandbox } from './sandbox';
import { workspaces } from './workspaces';
import { refuseDuplicateKeys } from './yaml-keys';

export type Generator = Pick<Task, 'run' | 'inputs' | 'links'>;

export function generate(decl: Generator, tree: RefTree, dirty: string[], project: string) {
  const capture = new Capture({ project, kind: 'generators', task: 'generate', live: false });
  let sandbox: Sandbox | undefined;
  let output: string | undefined;
  let closed = false;
  let temporary: string | undefined;
  try {
    if (decl.inputs.some((input) => typeof input !== 'string' && 'dotenv' in input))
      throw new Error('dotenv inputs are not supported');
    const view = dirty.length ? new WorkingTree(tree, dirty) : tree;
    const present = dirty.filter((path) => view.files.has(path));
    const selected = select(decl, view, present, dirty.length > 0);
    if (selected.reason) throw new Error(selected.reason);
    for (const input of decl.inputs) {
      if (typeof input !== 'string' && 'path' in input) selected.paths.add(input.path);
    }
    for (const path of selected.paths) {
      if (!view.entry(path).mode) throw new Error(`missing input '${path}'`);
    }
    const identity = new Bun.CryptoHasher('sha256')
      .update(
        JSON.stringify([
          1,
          decl.run,
          decl.inputs,
          decl.links ?? [],
          [...selected.paths]
            .sort()
            .map((path) => [path, view.entry(path).mode, view.entry(path).blob]),
        ]),
      )
      .digest('hex');
    const cache = join(statePath(), 'generated');
    const entry = join(cache, `${identity}.json`);
    try {
      const cached = JSON.parse(readFileSync(entry, 'utf8'));
      if (
        !Array.isArray(cached) ||
        !cached.length ||
        cached.some(
          (item) =>
            !Array.isArray(item) ||
            item.length !== 2 ||
            item.some((part) => typeof part !== 'string'),
        )
      )
        throw new Error('invalid cached declarations');
      capture.close();
      closed = true;
      const log = capture.finish('green');
      if (log.error) throw new Error(`log failed: ${log.error}`);
      return cached as [string, string][];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(`cache '${entry}': ${error}`);
    }
    sandbox = new Sandbox();
    sandbox.materialize(selected.paths, tree, dirty);
    const inspection = inspectLinks(decl.links ?? [], tree.files.keys(), () =>
      workspaces(source(view)).names(),
    );
    if (inspection.escapes.length) throw new Error(inspection.escapes.join('; '));
    sandbox.link(decl.links ?? [], inspection);
    output = mkdtempSync(join(tmpdir(), 'proof-declarations-'));
    const env: Record<string, string> = { PROOF_DECLARATIONS: output };
    for (const name of BASE_ENV) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    const result = Bun.spawnSync(['sh', '-c', decl.run], {
      cwd: sandbox.path,
      env,
      stdout: capture.fd,
      stderr: capture.fd,
    });
    if (result.exitCode !== 0) throw new Error(`command '${decl.run}' exited ${result.exitCode}`);
    const generated: [string, string][] = [];
    function walk(directory: string, prefix = '') {
      for (const name of readdirSync(directory).sort()) {
        const path = join(directory, name);
        const relative = prefix + name;
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new Error(`output '${relative}': symlink`);
        if (stat.isDirectory()) walk(path, `${relative}/`);
        else if (name.endsWith('.yaml')) {
          if (!stat.isFile()) throw new Error(`output '${relative}': not a regular file`);
          const text = readFileSync(path, 'utf8');
          Bun.YAML.parse(text);
          refuseDuplicateKeys(text);
          generated.push([relative, text]);
        }
      }
    }
    walk(output);
    if (!generated.length) throw new Error('no *.yaml output');
    generated.sort(([a], [b]) => a.localeCompare(b));
    mkdirSync(cache, { recursive: true });
    temporary = join(cache, `${identity}-${crypto.randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(generated), { mode: 0o600 });
    renameSync(temporary, entry);
    prune(cache);
    capture.close();
    closed = true;
    const log = capture.finish('green');
    if (log.error) throw new Error(`log failed: ${log.error}`);
    return generated;
  } catch (error) {
    if (!closed) {
      writeSync(capture.fd, `${error}\n`);
      capture.close();
    }
    throw new Error(`proof.yaml generate: ${error}${logSuffix(capture.finish('red'))}`);
  } finally {
    if (temporary) rmSync(temporary, { force: true });
    sandbox?.close();
    if (output) rmSync(output, { recursive: true, force: true });
  }
}

function prune(directory: string) {
  try {
    const entries = readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({
        path: join(directory, name),
        time: statSync(join(directory, name)).mtimeMs,
      }))
      .sort((a, b) => b.time - a.time);
    for (const entry of entries.slice(32)) unlinkSync(entry.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

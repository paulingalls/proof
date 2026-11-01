import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    capture.close();
    const log = capture.finish('green');
    if (log.error) throw new Error(`log failed: ${log.error}`);
    return generated.sort(([a], [b]) => a.localeCompare(b));
  } catch (error) {
    writeSync(capture.fd, `${error}\n`);
    capture.close();
    throw new Error(`proof.yaml generate: ${error}${logSuffix(capture.finish('red'))}`);
  } finally {
    sandbox?.close();
    if (output) rmSync(output, { recursive: true, force: true });
  }
}

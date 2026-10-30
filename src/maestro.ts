import { posix } from 'node:path';
import type { Source } from './imports';
import { refuseDuplicateKeys } from './yaml-keys';

type Closure = { paths: Set<string>; reason?: string };
const closures = new WeakMap<Source, Map<string, Closure>>();
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function maestro(entry: string, view: Source): Closure {
  let cached = closures.get(view);
  if (!cached) {
    cached = new Map();
    closures.set(view, cached);
  }
  const prior = cached.get(entry);
  if (prior) return prior;
  const paths = new Set<string>();
  const flows = new Set<string>();
  const containers = new WeakSet<object>();
  let reason: string | undefined;
  function fail(flow: string, reference: unknown, detail: string) {
    reason ??= `${flow}: reference '${String(reference)}': ${detail}`;
  }
  function visit(path: string, flow: string, reference: string, parse: boolean) {
    if (reference.includes('${')) {
      return fail(flow, reference, 'variable path');
    }
    if (
      posix.isAbsolute(reference) ||
      path === '..' ||
      path.startsWith('../') ||
      reference.split('/').includes('.git') ||
      path.split('/').includes('.git')
    ) {
      return fail(flow, reference, 'unsafe path');
    }
    const mode = view.mode(path);
    if (mode !== '100644' && mode !== '100755') {
      return fail(flow, reference, mode ? `unsupported mode ${mode}` : 'missing tracked file');
    }
    paths.add(path);
    if (!parse || flows.has(path)) return;
    flows.add(path);
    try {
      const text = view.read(path);
      if (text === undefined) return fail(flow, reference, 'missing tracked file');
      const docs = Bun.YAML.parse(text);
      // The parser keeps the last of a repeated key; whether Maestro does too is unknown, so a
      // flow with one can't be keyed by what Maestro will run.
      refuseDuplicateKeys(text);
      if (
        !Array.isArray(docs) ||
        docs.length !== 2 ||
        !object(docs[0]) ||
        !Array.isArray(docs[1])
      ) {
        return fail(path, path, 'parse failure: expected configuration and command sequence');
      }
      commands(docs[1], path);
      for (const hook of ['onFlowStart', 'onFlowComplete']) {
        if (hook in docs[0]) commands(docs[0][hook], path);
      }
    } catch (error) {
      fail(path, path, `parse failure: ${error}`);
    }
  }
  function include(value: unknown, flow: string, parse: boolean) {
    if (typeof value !== 'string' || !value.trim()) {
      return fail(flow, value, 'expected path');
    }
    visit(posix.join(posix.dirname(flow), value), flow, value, parse);
  }
  function commands(values: unknown, flow: string) {
    if (!Array.isArray(values)) {
      return fail(flow, 'commands', 'expected command sequence');
    }
    if (containers.has(values)) return;
    containers.add(values);
    for (const command of values) {
      if (typeof command === 'string' && command.trim()) continue;
      if (!object(command)) {
        fail(flow, command, 'expected command');
        continue;
      }
      for (const [kind, value] of Object.entries(command)) {
        if (kind === 'runScript') {
          include(object(value) ? value.file : value, flow, false);
        }
        if (['runFlow', 'retry', 'repeat'].includes(kind)) {
          if (typeof value === 'string' && kind === 'runFlow') {
            include(value, flow, true);
          } else if (object(value)) {
            if ('file' in value && kind !== 'repeat') {
              include(value.file, flow, true);
            }
            if ('commands' in value) {
              commands(value.commands, flow);
            }
            if (!('commands' in value) && !(kind !== 'repeat' && 'file' in value)) {
              fail(flow, kind, 'expected file or commands');
            }
          } else {
            fail(flow, kind, 'expected file or commands');
          }
        }
        if (kind === 'addMedia') {
          const files = object(value) ? value.files : value;
          if (!Array.isArray(files)) {
            fail(flow, kind, 'expected media list');
          } else {
            for (const file of files) include(file, flow, false);
          }
        }
      }
    }
  }
  if (posix.isAbsolute(entry) || entry.split('/').some((part) => ['..', '.git'].includes(part))) {
    fail(entry, entry, 'unsafe entry');
  } else visit(entry, entry, entry, true);
  const result = { paths, reason };
  cached.set(entry, result);
  return result;
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function storeConfig(project: string): { url?: string; excluded?: string } {
  let value = process.env.PROOF_STORE;
  let source = 'PROOF_STORE';
  let projects: string[] = [];
  if (value === undefined) {
    const { XDG_CONFIG_HOME, HOME } = process.env;
    const base = XDG_CONFIG_HOME || (HOME ? join(HOME, '.config') : undefined);
    if (!base) return {};
    source = join(base, 'proof/store');
    try {
      const lines = readFileSync(source, 'utf8').split(/\r?\n/);
      value = lines[0];
      projects = lines.slice(1).filter((name) => name.length > 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error(`cannot read store configuration from ${source}`);
    }
  }
  try {
    const url = new URL(value ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname)
      throw new Error('invalid URL');
    if (projects.length && !projects.includes(project))
      return { excluded: `store not used: project '${project}' is not listed in ${source}` };
    return { url: url.href };
  } catch {
    throw new Error(`invalid store configuration from ${source}: expected a Postgres URL`);
  }
}

export function statePath() {
  const { PROOF_STATE_DIR, XDG_STATE_HOME, HOME } = process.env;
  const base =
    PROOF_STATE_DIR ||
    (XDG_STATE_HOME
      ? join(XDG_STATE_HOME, 'proof')
      : HOME
        ? join(HOME, '.local/state/proof')
        : undefined);
  if (!base) throw new Error('set PROOF_STATE_DIR, XDG_STATE_HOME or HOME for the proof store');
  return base;
}

export function redacted(value: string) {
  // An unencoded '/' or '?' moves a password into the path or query, so print neither.
  const url = new URL(value);
  return `${url.protocol}//${url.host}`;
}

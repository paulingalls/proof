import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function storeUrl() {
  let value = process.env.PROOF_STORE;
  let source = 'PROOF_STORE';
  if (value === undefined) {
    const { XDG_CONFIG_HOME, HOME } = process.env;
    const base = XDG_CONFIG_HOME || (HOME ? join(HOME, '.config') : undefined);
    if (!base) return undefined;
    source = join(base, 'proof/store');
    try {
      value = readFileSync(source, 'utf8').split(/\r?\n/, 1)[0];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error(`cannot read store configuration from ${source}`);
    }
  }
  try {
    const url = new URL(value ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname)
      throw new Error('invalid URL');
    return url.href;
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
  const url = new URL(value);
  if (url.password) url.password = 'REDACTED';
  url.searchParams.delete('password');
  return url.href;
}

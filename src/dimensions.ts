type Resolution = { value: string; failure?: never } | { failure: string; value?: never };
const values = new Map<string, Resolution>();

export function dimension(name: string, command: string) {
  let resolved = values.get(command);
  if (resolved === undefined) {
    const result = Bun.spawnSync(['sh', '-c', command]);
    const value = result.stdout.toString().trim();
    resolved = !result.success
      ? { failure: 'command failed' }
      : !value
        ? { failure: 'empty output' }
        : { value };
    values.set(command, resolved);
  }
  return resolved.failure === undefined
    ? { value: resolved.value }
    : { reason: `dimension '${name}': ${resolved.failure}` };
}

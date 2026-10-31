const values = new Map<string, string>();

export function dimension(_name: string, command: string) {
  let value = values.get(command);
  if (value === undefined) {
    const result = Bun.spawnSync(['sh', '-c', command]);
    value = result.stdout.toString().trim();
    values.set(command, value);
  }
  return { value };
}

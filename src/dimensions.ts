export function dimension(name: string, command: string) {
  const result = Bun.spawnSync(['sh', '-c', command]);
  return { value: result.stdout.toString().trim() };
}

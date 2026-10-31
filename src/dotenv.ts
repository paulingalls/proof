export function dotenv(source: string, path: string) {
  const values = new Map<string, string>();
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    const invalid = () => new Error(`input '${path}': invalid dotenv at line ${index + 1}`);
    if (!assignment) throw invalid();
    const name = assignment[1] as string;
    const untrimmed = assignment[2] as string;
    const raw = untrimmed.trimStart();
    let value: string;
    if (raw.startsWith('"') || raw.startsWith("'")) {
      const quoted = raw.startsWith('"')
        ? /^"((?:[^"\\]|\\.)*)"(.*)$/.exec(raw)
        : /^'([^']*)'(.*)$/.exec(raw);
      if (!quoted || !/^(?:\s*|\s+#.*)$/.test(quoted[2] as string)) throw invalid();
      value = quoted[1] as string;
    } else value = untrimmed.replace(/\s+#.*$/, '').trim();
    values.set(name, value);
  }
  return values;
}

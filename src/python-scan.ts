type Token = { text: string; literal?: string };
export type PythonImport = { name: string; members?: string[] };

function tokens(source: string): Token[] {
  const result: Token[] = [];
  let i = 0;
  let depth = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const skip = /^(?:[ \t\r]+|#[^\n]*|\\\r?\n)/.exec(rest);
    if (skip) {
      i += skip[0].length;
      continue;
    }
    const quoted = /^(?:[rRuUbBfF]{0,2})("""|'''|"|')/.exec(rest);
    if (quoted) {
      const quote = quoted[1] as string;
      i += quoted[0].length;
      const start = i;
      while (i < source.length && !source.startsWith(quote, i)) {
        if (source[i] === '\\') i++;
        i++;
      }
      const value = source.slice(start, i);
      i += quote.length;
      result.push({ text: '<string>', literal: value });
      continue;
    }
    const word = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(rest);
    if (word) {
      result.push({ text: word[0] });
      i += word[0].length;
      continue;
    }
    const c = source[i++] as string;
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c !== '\n' || depth === 0) result.push({ text: c });
  }
  return result;
}

export function pythonScan(source: string) {
  const ts = tokens(source);
  const imports: PythonImport[] = [];
  for (let i = 0; i < ts.length; i++) {
    if (ts[i]?.text !== 'import') continue;
    i++;
    while (i < ts.length) {
      let name = ts[i++]?.text ?? '';
      while (ts[i]?.text === '.' && ts[i + 1]) {
        name += `.${ts[i + 1]?.text}`;
        i += 2;
      }
      if (name) imports.push({ name });
      if (ts[i]?.text === 'as') i += 2;
      if (ts[i]?.text !== ',') break;
      i++;
    }
  }
  return { imports };
}

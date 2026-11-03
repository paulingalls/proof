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
      result.push({
        text: '<string>',
        literal: /[fb]/i.test(quoted[0].slice(0, -quote.length)) ? undefined : value,
      });
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
  let reason: string | undefined;
  for (let n = 0; n < ts.length; n++) {
    let call = ts[n]?.text;
    let open = n + 1;
    if (call === 'importlib' && ts[n + 1]?.text === '.' && ts[n + 2]?.text === 'import_module') {
      call = 'importlib.import_module';
      open = n + 3;
    } else if (!['import_module', '__import__'].includes(call ?? '') || ts[n - 1]?.text === '.')
      continue;
    if (ts[open]?.text !== '(') continue;
    const arg = ts[open + 1];
    const end = ts[open + 2]?.text;
    if (
      arg?.literal !== undefined &&
      [')', ','].includes(end ?? '') &&
      !arg.literal.startsWith('.')
    ) {
      imports.push({ name: arg.literal });
    } else reason ??= `${call}(): non-literal module or unsupported relative context`;
  }
  let i = 0;
  function name() {
    let result = '';
    while (ts[i]?.text === '.') result += ts[i++]?.text;
    if (ts[i]?.text !== 'import' && /^[\p{L}_][\p{L}\p{N}_]*$/u.test(ts[i]?.text ?? '')) {
      result += ts[i++]?.text;
      while (ts[i]?.text === '.' && /^[\p{L}_]/u.test(ts[i + 1]?.text ?? '')) {
        result += `.${ts[i + 1]?.text}`;
        i += 2;
      }
    }
    return result;
  }
  function names() {
    const result: string[] = [];
    if (ts[i]?.text === '(') i++;
    while (i < ts.length) {
      const value = name();
      if (!value) break;
      result.push(value);
      if (ts[i]?.text === 'as') i += 2;
      if (ts[i]?.text !== ',') break;
      i++;
    }
    return result;
  }
  while (i < ts.length) {
    const token = ts[i++]?.text;
    if (token === 'from') {
      const base = name();
      if (ts[i]?.text === 'import') {
        i++;
        imports.push({ name: base, members: names() });
      }
    } else if (token === 'import') {
      for (const value of names()) imports.push({ name: value });
    }
  }
  return { imports, reason };
}

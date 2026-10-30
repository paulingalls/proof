export function refuseDuplicateKeys(source: string): void {
  const text = source.replace(/^\uFEFF/, '');
  let pos = 0;
  const line = (offset: number) => text.slice(0, offset).split('\n').length;
  const column = () => pos - (text.lastIndexOf('\n', pos - 1) + 1);
  const endLine = () => {
    const end = text.indexOf('\n', pos);
    pos = end < 0 ? text.length : end + 1;
  };
  const space = () => {
    while (pos < text.length) {
      if (/\s/.test(text[pos] ?? '')) pos++;
      else if (text[pos] === '#') endLine();
      else break;
    }
  };
  const horizontal = () => {
    while (text[pos] === ' ' || text[pos] === '\t' || text[pos] === '\r') pos++;
  };
  const quoted = () => {
    const quote = text[pos++];
    while (pos < text.length) {
      const c = text[pos++];
      if (quote === '"' && c === '\\') pos++;
      else if (c === quote) {
        if (quote === "'" && text[pos] === "'") pos++;
        else return;
      }
    }
  };
  const add = (keys: Set<string>, start: number, end: number) => {
    const raw = text.slice(start, end).trim();
    let value: unknown;
    try {
      value = raw === '' ? null : Bun.YAML.parse(raw);
    } catch {
      throw new Error(`line ${line(start)}: unsupported key`);
    }
    if ((value !== null && typeof value === 'object') || /^\*|^[&!][^\s]+\s+[*[{]/.test(raw)) {
      throw new Error(`line ${line(start)}: unsupported key`);
    }
    const key = String(value);
    if (keys.has(key)) throw new Error(`line ${line(start)}: duplicate key '${key}'`);
    keys.add(key);
  };
  const separator = (flow: boolean) =>
    text[pos] === ':' &&
    ((flow && (text[pos - 1] === '"' || text[pos - 1] === "'")) ||
      pos + 1 === text.length ||
      /\s/.test(text[pos + 1] ?? '') ||
      (flow && /[,[\]{}]/.test(text[pos + 1] ?? '')));
  function scalar(flow: boolean) {
    const start = pos;
    while (pos < text.length) {
      const c = text[pos];
      if ((c === '"' || c === "'") && /^(?:[&!]\S+\s+)*$/.test(text.slice(start, pos))) quoted();
      else if (
        c === '\n' ||
        c === '\r' ||
        (c === '#' && /\s/.test(text[pos - 1] ?? ' ')) ||
        separator(flow) ||
        (flow && /[,[\]{}]/.test(c ?? ''))
      )
        return;
      else pos++;
    }
  }
  function flow() {
    const mapping = text[pos++] === '{';
    const close = mapping ? '}' : ']';
    const keys = new Set<string>();
    space();
    while (pos < text.length && text[pos] !== close) {
      if (text[pos] === '?' && /\s/.test(text[pos + 1] ?? '')) {
        pos++;
        space();
      }
      const start = pos;
      if (text[pos] === '{' || text[pos] === '[') {
        if (mapping) throw new Error(`line ${line(start)}: unsupported key`);
        flow();
      } else scalar(true);
      if (mapping) add(keys, start, pos);
      space();
      if (text[pos] === ':') {
        // Flow sequences may contain an implicit one-entry mapping.
        if (!mapping) add(new Set(), start, pos);
        pos++;
        space();
        flowValue();
      }
      space();
      if (text[pos] === ',') {
        pos++;
        space();
      } else if (text[pos] !== close) {
        throw new Error(`line ${line(pos)}: unsupported YAML construct`);
      }
    }
    pos++;
  }
  function flowValue() {
    // Properties belong to the following node, which can itself be a container.
    while (text[pos] === '&' || text[pos] === '!') {
      while (pos < text.length && !/\s/.test(text[pos] ?? '')) pos++;
      space();
    }
    if (text[pos] === '{' || text[pos] === '[') flow();
    else {
      // A plain value's non-separator colons are scalar content.
      const start = pos;
      while (pos < text.length && !/[,\]}]/.test(text[pos] ?? '')) {
        if ((text[pos] === '"' || text[pos] === "'") && pos === start) quoted();
        else if (text[pos] === '#' && /\s/.test(text[pos - 1] ?? ' ')) endLine();
        else pos++;
      }
    }
  }
  function value(indent: number) {
    horizontal();
    while (text[pos] === '&' || text[pos] === '!') {
      while (pos < text.length && !/\s/.test(text[pos] ?? '')) pos++;
      horizontal();
    }
    if (text[pos] === '|' || text[pos] === '>') {
      endLine();
      while (pos < text.length) {
        const start = pos;
        horizontal();
        if (text[pos] !== '\n' && column() <= indent) {
          pos = start;
          return;
        }
        endLine();
      }
    } else if (text[pos] === '[' || text[pos] === '{') {
      flow();
      endLine();
    } else if (text[pos] === '"' || text[pos] === "'") {
      quoted();
      endLine();
    } else if (text[pos] === '\n' || text[pos] === '#' || pos === text.length) {
      endLine();
      space();
      if (pos < text.length && (column() > indent || (column() === indent && text[pos] === '-')))
        block(column());
    } else {
      endLine();
      // Bun has already excluded mapping separators in plain continuation lines.
      while (pos < text.length) {
        const start = pos;
        horizontal();
        if (text[pos] !== '\n' && column() <= indent) {
          pos = start;
          return;
        }
        endLine();
      }
    }
  }
  function block(indent: number) {
    const first = pos;
    const keys = new Set<string>();
    const sequence = text[pos] === '-' && /\s/.test(text[pos + 1] ?? '');
    while (pos < text.length) {
      space();
      if (pos === text.length || column() < indent) return;
      if ((column() !== indent && pos !== first) || /^(?:---|\.\.\.)(?:\s|$)/.test(text.slice(pos)))
        return;
      if (sequence) {
        if (text[pos] !== '-' || !/\s/.test(text[pos + 1] ?? '')) return;
        pos++;
        entry(indent);
        continue;
      }
      if (text[pos] === '[' || text[pos] === '{') {
        const start = pos;
        flow();
        horizontal();
        if (text[pos] === ':') throw new Error(`line ${line(start)}: unsupported key`);
        endLine();
        return;
      }
      const explicit = text[pos] === '?' && /\s/.test(text[pos + 1] ?? '');
      if (explicit) {
        pos++;
        space();
      }
      const start = pos;
      if (text[pos] === '[' || text[pos] === '{') {
        throw new Error(`line ${line(start)}: unsupported key`);
      }
      scalar(false);
      if (explicit) {
        add(keys, start, pos);
        space();
        if (text[pos] !== ':') continue;
      } else if (text[pos] === ':') add(keys, start, pos);
      else {
        endLine();
        return;
      }
      pos++;
      if (explicit) entry(indent);
      else value(indent);
    }
  }
  // After `- ` or an explicit `: `, a node on the same line is a compact mapping only when a
  // key separator follows its first scalar; otherwise it is a value that may span lines.
  function entry(indent: number) {
    horizontal();
    const start = pos;
    if (text[pos] === '\n' || text[pos] === '#') return value(indent);
    const explicit = text[pos] === '?' && /\s/.test(text[pos + 1] ?? '');
    if (!explicit && text[pos] !== '[' && text[pos] !== '{') scalar(false);
    const mapping = pos === start || text[pos] === ':';
    pos = start;
    if (mapping) block(column());
    else value(indent);
  }
  while (pos < text.length) {
    space();
    if (text[pos] === '%' || /^(?:---|\.\.\.)(?:\s|$)/.test(text.slice(pos))) endLine();
    else if (pos < text.length) {
      const indent = column();
      while (text[pos] === '&' || text[pos] === '!') {
        while (pos < text.length && !/\s/.test(text[pos] ?? '')) pos++;
        space();
      }
      block(indent);
    }
  }
}

import type { Edge } from './workspaces';

// A lazy comment body can retry past each `*/`; that blowup hits the engine's backtrack limit,
// which ends a global replace with no error and leaves later type-only imports erased.
const gap = String.raw`(?:\s|/\*[^*]*(?:\*(?!/)[^*]*)*\*/|//[^\n]*(?:\n|$))*`;
const literal = /('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)/.source;
// The scanner erases type-only edges; expose them without interpreting import-looking text.
function valueImports(text: string) {
  const name = String.raw`[$\w\u0080-\uffff]+(?![$\w\u0080-\uffff])`;
  const named = String.raw`\{(?:${gap}${name})*(?:${gap},(?:${gap}${name})*)*${gap}\}`;
  const clause = String.raw`(?:${named}|\*(?:${gap}as${gap}${name})?|${name}(?:${gap},${gap}${named})?)`;
  const statement = new RegExp(
    String.raw`\b(import|export)${gap}(type\b${gap})?(${clause})(${gap}from${gap}${literal})`,
    'g',
  );
  const inline = new RegExp(String.raw`(^|,)${gap}type\b${gap}(?!as\b)(${name})`, 'g');
  return text.replace(statement, (_, kind, _type, clause: string, tail) => {
    const values = clause.replace(
      /\{([\s\S]*)\}/,
      (_, names: string) => `{${names.replace(inline, '$1 $2')}}`,
    );
    return `${kind} ${values}${tail}`;
  });
}
function inertRanges(text: string) {
  const ranges: [number, number][] = [];
  for (let i = 0; i < text.length; i++) {
    const start = i;
    const quote = text[i];
    if (quote === "'" || quote === '"' || quote === '`') {
      let end = i + 1;
      let closed = false;
      while (end < text.length) {
        if (quote !== '`' && /[\r\n]/.test(text[end] as string)) break;
        if (text[end] === quote) {
          closed = true;
          end++;
          break;
        }
        if (text[end] === '\\') {
          end++;
          if (quote !== '`' && /[\r\n]/.test(text[end] ?? '')) break;
        }
        end++;
      }
      if (quote === '`' && !closed) continue;
      i = end - 1;
    } else if (text.startsWith('//', i)) {
      while (i + 1 < text.length && !/[\r\n]/.test(text[i + 1] as string)) i++;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) continue;
      i = end + 1;
    } else continue;
    ranges.push([start, i + 1]);
  }
  return ranges;
}
export type Loader = 'ts' | 'tsx' | 'jsx' | 'js';
function supplement(text: string, loader: Loader) {
  const edges: Edge[] = [];
  let reason: string | undefined;
  const call = () => new RegExp(String.raw`\b(?:import|require)${gap}\(${gap}`, 'g');
  const literalArgument = new RegExp(String.raw`^${literal}${gap}(?:\)|,)`);
  // Newline recovery bounds quote confusion from JSX/regex text. Template interpolation is
  // skipped here; Bun still sees literal imports there. Regex backticks or /* can hide calls
  // up to their closer: this is deliberately not a complete JavaScript tokenizer.
  const runs = () => {
    const code = new Bun.Transpiler({ loader }).transformSync(text);
    const ranges = inertRanges(code);
    return [...code.matchAll(call())].some(
      (match) =>
        !ranges.some(([start, end]) => start <= match.index && match.index < end) &&
        !literalArgument.test(code.slice(match.index + match[0].length)),
    );
  };
  function add(value: string, kind: Edge['kind']) {
    if (value.includes('\\') || value.includes('${')) reason ??= `ambiguous import ${value}`;
    else edges.push({ specifier: value.slice(1, -1), kind });
  }
  let ranges: [number, number][] | undefined;
  for (const match of text.matchAll(call())) {
    ranges ??= inertRanges(text);
    if (ranges.some(([start, end]) => start <= match.index && match.index < end)) continue;
    const tail = text.slice((match.index ?? 0) + match[0].length);
    const arg = literalArgument.exec(tail);
    if (arg?.[1]) add(arg[1], match[0].startsWith('require') ? 'require' : 'import');
    else if (!reason && runs()) reason = `computed import ${tail.split(')')[0]}`;
  }
  return { edges, reason };
}
const scans = new Map<string, { edges: Edge[]; reason?: string }>();
export function scan(text: string, loader: Loader) {
  const id = new Bun.CryptoHasher('sha256').update(text).digest('hex') + loader;
  let result = scans.get(id);
  if (!result) {
    try {
      const extra = supplement(text, loader);
      result = {
        edges: [
          ...new Map(
            [
              ...new Bun.Transpiler({ loader }).scanImports(valueImports(text)).map(
                (edge): Edge => ({
                  specifier: edge.path,
                  kind: edge.kind === 'require-call' ? 'require' : 'import',
                }),
              ),
              ...extra.edges,
            ].map((edge) => [JSON.stringify(edge), edge]),
          ).values(),
        ],
        reason: extra.reason,
      };
    } catch (error) {
      result = { edges: [], reason: `parse failure: ${error}` };
    }
    scans.set(id, result);
  }
  return result;
}

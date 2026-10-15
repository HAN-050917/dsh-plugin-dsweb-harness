/**
 * Lifts a single `function name(...) { ... }` out of the plugin's client bundle.
 *
 * The preview builders and test-think.mjs all need the real component source
 * rather than a copy, so a change to client.js is reflected in what they render
 * and measure. Three hand-rolled copies of this scan already drifted once (one
 * lacked the regex-literal handling below, which truncated the markdown section
 * mid-expression), so it lives here now and callers share it.
 *
 * A plain brace counter is not enough: the lifted section contains regex
 * literals, and a quantifier like `{2,}` opens no brace but closes one, which
 * ends the scan in the middle of a function. The scanner therefore skips
 * strings, template literals, comments and regexes, and counts braces only in
 * real code.
 */

/** @returns {{snippet: string, start: number, end: number}} offsets into `source`. */
export function liftFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`client.js must define ${name}()`);
  let depth = 0;
  let started = false;
  let previous = '';
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (char === '/' && next === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    if (char === '/' && next === '*') {
      i = source.indexOf('*/', i + 2) + 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      for (i += 1; i < source.length; i += 1) {
        if (source[i] === '\\') i += 1;
        else if (source[i] === char) break;
      }
      previous = char;
      continue;
    }
    // A `/` after a value is division; after an operator, `(`, `,`, `=` or the
    // start of a statement it opens a regex literal.
    if (char === '/' && !/[\w)\]]$/.test(previous)) {
      for (i += 1; i < source.length; i += 1) {
        if (source[i] === '\\') i += 1;
        else if (source[i] === '\n') break;
        else if (source[i] === '/') break;
        else if (source[i] === '[') {
          while (i < source.length && source[i] !== ']') {
            if (source[i] === '\\') i += 1;
            i += 1;
          }
        }
      }
      previous = '/';
      continue;
    }
    if (char === '{') {
      depth += 1;
      started = true;
    } else if (char === '}') {
      depth -= 1;
      if (started && depth === 0) return { snippet: source.slice(start, i + 1), start, end: i + 1 };
    }
    if (!/\s/.test(char)) previous = char;
  }
  throw new Error(`${name}() body must be brace-balanced`);
}

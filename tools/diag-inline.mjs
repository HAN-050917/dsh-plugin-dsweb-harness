/** One-off: how does INLINE_PATTERN split a few tricky strings? */
const INLINE_PATTERN = /(?<!\\)(`+[^`\n]*`+|!\[[^\]\n]*\]\([^)\s]+\)|\[[^\]\n]+\]\([^)\s]+\)|<https?:\/\/[^>\s]+>|\*\*\*[^*\n]+?\*\*\*|\*\*[^\n]+?\*\*|__[^_\n]+?__|~~[^\n]+?~~|\*[^*\n]+?\*|_[^_\n]+?_)/g;

for (const sample of ['**粗`代`体**', '\\*不是斜体\\* 但 *是*', '**粗**和`代`码', '***粗斜***']) {
  const pattern = new RegExp(INLINE_PATTERN.source, 'g');
  const out = [];
  let match;
  let cursor = 0;
  while ((match = pattern.exec(sample)) !== null) {
    if (match.index > cursor) out.push(`TEXT(${JSON.stringify(sample.slice(cursor, match.index))})`);
    out.push(`TOKEN(${JSON.stringify(match[0])})`);
    cursor = match.index + match[0].length;
  }
  if (cursor < sample.length) out.push(`TEXT(${JSON.stringify(sample.slice(cursor))})`);
  console.log(JSON.stringify(sample), '->', out.join(' '));
}

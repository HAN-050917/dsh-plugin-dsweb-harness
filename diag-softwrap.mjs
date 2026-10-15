import { readFileSync } from 'node:fs';

const raw = readFileSync(new URL('./fixtures/history-sample.json', import.meta.url), 'utf8');
const doc = JSON.parse(raw);
const messages = doc.data.biz_data.chat_messages;

for (const message of messages) {
  if (message.role !== 'ASSISTANT') continue;
  for (const fragment of message.fragments) {
    if (fragment.type !== 'RESPONSE' || !fragment.content) continue;
    const lines = fragment.content.replace(/\r\n?/g, '\n').split('\n');
    const blank = lines.filter((line) => !line.trim()).length;
    const single = [];
    for (let i = 1; i < lines.length; i += 1) {
      const prev = lines[i - 1];
      const cur = lines[i];
      if (!prev.trim() || !cur.trim()) continue;
      // A single newline between two non-empty lines that are NOT both list
      // items / headings: that is a soft wrap, the case softJoin exists for.
      const listish = /^\s*(?:[-*+]|\d+[.)])\s/.test(prev) || /^\s*(?:[-*+]|\d+[.)])\s/.test(cur);
      const heading = /^#{1,6}\s/.test(prev) || /^#{1,6}\s/.test(cur);
      if (!listish && !heading) single.push(`${prev.slice(-18)} ⏎ ${cur.slice(0, 18)}`);
    }
    console.log(`fragment ${fragment.id}: ${lines.length} lines, ${blank} blank, ${single.length} soft wraps`);
    for (const item of single.slice(0, 6)) console.log('   ', JSON.stringify(item));
  }
}

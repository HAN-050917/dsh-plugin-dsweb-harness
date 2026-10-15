/**
 * Regenerates fixtures/theme-tokens.json from the shipped theme bundle.
 *
 * The plugin's stylesheet is verified against the tokens the app actually
 * declares, so the list has to come from the app rather than from memory. Run
 * this after a Harness update, then run `node test-style.mjs`:
 *
 *   node tools/dump-theme-tokens.mjs
 *
 * The asar is a single archive, so the theme bundle is read from an extracted
 * copy. Extract it first if the path below does not exist:
 *
 *   node <asar tool> extract <app.asar> dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'fixtures', 'theme-tokens.json');

const candidates = [
  join(here, '..', '..', '_asar', 'ui5', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js'),
  join(here, '..', '..', '_asar', 'ui4', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js'),
  join(here, '..', '..', '_asar', 'ui3', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js'),
];
const themePath = candidates.find((path) => existsSync(path));
if (!themePath) {
  console.error('theme bundle not found; looked in:\n  ' + candidates.join('\n  '));
  process.exit(1);
}

const theme = readFileSync(themePath, 'utf8');
const tokens = new Set();
for (const match of theme.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)) tokens.add(match[1]);

// Variables the shell sets on the page at runtime rather than declaring in the
// token sheet: the content size scale and the conversation column geometry.
const runtime = [
  '--dsh-content-font-size',
  '--dsh-content-font-delta',
  '--dsh-chat-content-width',
  '--dsh-conversation-column-width',
  '--dsh-chat-user-width',
  '--dsh-segment-count',
  '--dsh-segment-index',
];

writeFileSync(
  out,
  JSON.stringify(
    {
      note:
        'Every --* custom property the shipped theme sheet defines, plus the --dsh-* runtime variables the shell sets on the page. Extracted from @deepseek-ai/dsh-client-ui-theme\'s client bundle. Used by test-style.mjs so a typo such as --dsw-alias-border-l03 fails instead of silently rendering nothing.',
      tokens: [...tokens].sort(),
      runtime,
    },
    null,
    2,
  ) + '\n',
);
console.log(`${out}: ${tokens.size} theme tokens, ${runtime.length} runtime variables`);

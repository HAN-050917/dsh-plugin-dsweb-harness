/**
 * Collects the stylesheets a real page receives, so a preview can render inside
 * the shipped theme instead of the plugin's own fallbacks.
 *
 * The theme package does not ship a .css file: its token sheet is emitted as
 * inline CSS string literals (`var base_css_default = ":root{--dsw-…}"`) inside
 * its client bundle. Reading only the extracted `index-*.css` therefore yields a
 * page where every `var(--dsw-…)` resolves to nothing — measurements taken there
 * describe the fallbacks, not the design.
 *
 *   import { readThemeCss, readShippedCss } from './extract-theme-css.mjs';
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workspace = join(here, '..', '..');

/** Inline `:root{…}` / `body{…}` token sheets from the theme bundle. */
export function readThemeCss() {
  const candidates = [
    join(workspace, '_asar', 'ui4', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js'),
    join(workspace, '_asar', 'ui3', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js'),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path === undefined) return null;

  const source = readFileSync(path, 'utf8');
  const sheets = [];
  // `var <name>_css_default = "<css>";` — the bundle's inline-CSS convention.
  const pattern = /var\s+[A-Za-z0-9_$]+_css_default\s*=\s*("(?:[^"\\]|\\.)*")\s*;/g;
  for (const match of source.matchAll(pattern)) sheets.push(JSON.parse(match[1]));
  return sheets.length === 0 ? null : sheets.join('\n');
}

/** The compiled component stylesheets that do ship as files. */
export function readShippedCss() {
  return ['index-BPHePDI_.css', 'vendor-BNsW4eBh.css']
    .map((name) => join(workspace, '_asar', '_extract', name))
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, 'utf8'));
}

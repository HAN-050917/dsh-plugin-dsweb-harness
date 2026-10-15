/**
 * Token vault for the DeepSeek Web Chat plugin.
 *
 * The consumer-web bearer token is the user's own chat.deepseek.com session
 * credential: it can read and write their whole conversation history, so it is
 * kept out of the DSH config (which the settings UI renders) and out of the
 * browser (where any page script could read it).
 *
 * Stored as a single owner-only file beside the plugin's cache. DSH hands host
 * plugins no credential key space of their own, and the plugin-manager entry
 * for this bundle is not a security boundary, so a 0600 file under the DSH
 * state directory is the narrowest available option.
 *
 * @module dsh-deepseek-web-chat/vault
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR_NAME = 'dsh-deepseek-web-chat';
const VAULT_FILE = 'vault.json';

/** The plugin's private state directory under `$DSH_HOME`. */
export function resolveStateDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, DIR_NAME);
}

function vaultPath() {
  return join(resolveStateDir(), VAULT_FILE);
}

const EMPTY = { token: '', savedAt: null, user: null };

/** Read the vault; a missing or unreadable file is simply "no token". */
export function readVault() {
  const path = vaultPath();
  if (!existsSync(path)) return { ...EMPTY };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return {
      token: typeof parsed.token === 'string' ? parsed.token : '',
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : null,
      user: parsed.user && typeof parsed.user === 'object' ? parsed.user : null,
    };
  } catch {
    return { ...EMPTY };
  }
}

/** Persist a token and the account it belongs to. */
export function saveToken(token, user) {
  const record = {
    token: String(token || '').trim(),
    savedAt: new Date().toISOString(),
    user: user || null,
  };
  mkdirSync(resolveStateDir(), { recursive: true });
  const path = vaultPath();
  writeFileSync(path, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    // `mode` is ignored when the file already exists on some platforms.
    chmodSync(path, 0o600);
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
  return record;
}

/** Forget the token. Returns true when something was actually removed. */
export function clearToken() {
  const path = vaultPath();
  if (!existsSync(path)) return false;
  try {
    rmSync(path);
    return true;
  } catch {
    try {
      writeFileSync(path, JSON.stringify({ ...EMPTY }), 'utf8');
      return true;
    } catch {
      return false;
    }
  }
}

/** A short, non-reversible hint so the UI can show which token is stored. */
export function tokenPreview(token) {
  const value = String(token || '');
  if (!value) return '';
  if (value.length <= 12) return `${value.slice(0, 2)}…`;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

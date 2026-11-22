// Key files and profile folders (plan §1.4, SAFETY 7). The key never leaves this machine:
//   - created by the SDK's generateKey() + saveKey(path, key): PKCS#8 PEM, mode 0600, exclusive;
//   - the profile folder is re-checked after mkdir (0700) and refused if looser;
//   - lstat refuses a symlinked key file or profile folder;
//   - group or world bits on the key are refused unless AIPE_KEY_PERMS=trust (containers);
//   - every error is normalised (KEY_FILE_MISSING, KEY_FILE_UNREADABLE, KEY_FILE_INSECURE,
//     KEY_FILE_INVALID) and never contains a path.
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import { generateKey, loadKey, saveKey } from 'aipe-sdk';
import { LocalFailure } from './errors.ts';

export const KEY_FILE = 'key.pem';
export const NEXT_KEY_FILE = 'key.next.pem';
export const OLD_KEY_FILE = 'key.old.pem';
export const STATE_FILE = 'state.json';

export interface PathEnv {
  platform: NodeJS.Platform;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}

export function defaultPathEnv(): PathEnv {
  return { platform: process.platform, home: homedir(), env: process.env };
}

/** The folder that holds one sub-folder per profile. */
export function profileRoot(p: PathEnv): string {
  const override = p.env.AIPE_HOME;
  if (override !== undefined && override !== '') return override;
  if (p.platform === 'win32') {
    const appData = p.env.APPDATA ?? win32.join(p.home, 'AppData', 'Roaming');
    return win32.join(appData, 'aipe-mcp');
  }
  if (p.platform === 'darwin') return join(p.home, 'Library', 'Application Support', 'aipe-mcp');
  const xdg = p.env.XDG_CONFIG_HOME;
  return join(xdg !== undefined && xdg !== '' ? xdg : join(p.home, '.config'), 'aipe-mcp');
}

export interface KeyOptions {
  /** AIPE_KEY_PERMS=trust: skip the POSIX mode checks (mounted files in containers) */
  trustPerms: boolean;
  platform: NodeJS.Platform;
}

/** The Node system error code (ENOENT, EACCES, ...); undefined for anything else. */
function fsCode(err: unknown): string | undefined {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^E[A-Z0-9]+$/.test(c) ? c : undefined;
}

function fail(code: 'KEY_FILE_MISSING' | 'KEY_FILE_UNREADABLE' | 'KEY_FILE_INSECURE' | 'KEY_FILE_INVALID', message: string): never {
  throw new LocalFailure(code, message);
}

function fromFsError(err: unknown, what: 'key file' | 'profile folder'): never {
  const c = fsCode(err);
  if (c === 'ENOENT' || c === 'ENOTDIR') fail('KEY_FILE_MISSING', `the ${what} does not exist`);
  fail('KEY_FILE_UNREADABLE', `the ${what} cannot be read`);
}

function posixChecked(o: KeyOptions): boolean {
  return o.platform !== 'win32' && !o.trustPerms;
}

/** Creates the profile folder (0700) if needed, then re-checks it: real folder, no group/world bits. */
export async function ensureProfileDir(dir: string, o: KeyOptions): Promise<void> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    if (fsCode(err) !== 'EEXIST') fromFsError(err, 'profile folder');
  }
  await checkProfileDir(dir, o);
}

export async function checkProfileDir(dir: string, o: KeyOptions): Promise<void> {
  let st;
  try {
    st = await lstat(dir);
  } catch (err) {
    fromFsError(err, 'profile folder');
  }
  if (st.isSymbolicLink()) fail('KEY_FILE_INSECURE', 'the profile folder is a link');
  if (!st.isDirectory()) fail('KEY_FILE_INVALID', 'the profile folder is not a folder');
  if (posixChecked(o) && (st.mode & 0o077) !== 0) fail('KEY_FILE_INSECURE', 'the profile folder can be read by other users');
}

async function checkKeyFile(path: string, o: KeyOptions): Promise<{ ino: number; dev: number }> {
  let st;
  try {
    st = await lstat(path);
  } catch (err) {
    fromFsError(err, 'key file');
  }
  if (st.isSymbolicLink()) fail('KEY_FILE_INSECURE', 'the key file is a link');
  if (!st.isFile()) fail('KEY_FILE_INVALID', 'the key file is not a file');
  if (posixChecked(o) && (st.mode & 0o077) !== 0) fail('KEY_FILE_INSECURE', 'the key file can be read by other users');
  return { ino: st.ino, dev: st.dev };
}

/** Loads a key after the checks above; the file must not change between the check and the read. */
export async function loadKeyChecked(path: string, o: KeyOptions): Promise<Uint8Array> {
  const before = await checkKeyFile(path, o);
  let seed: Uint8Array;
  try {
    seed = await loadKey(path);
  } catch (err) {
    if (fsCode(err) !== undefined) fromFsError(err, 'key file');
    fail('KEY_FILE_INVALID', 'the key file is not a valid agent key');
  }
  const after = await checkKeyFile(path, o);
  if (after.ino !== before.ino || after.dev !== before.dev) fail('KEY_FILE_INSECURE', 'the key file changed while it was read');
  return seed;
}

/** true when a file (or link) exists at the path; never follows links. */
export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if (fsCode(err) === 'ENOENT') return false;
    return fromFsError(err, 'key file');
  }
}

/**
 * Generates a new key and writes it with the SDK (0600, exclusive create: never overwrites).
 * Returns the seed and keyid. The folder must already have passed ensureProfileDir.
 */
export async function createKey(path: string, o: KeyOptions): Promise<{ seed: Uint8Array; keyid: string }> {
  const k = generateKey();
  try {
    await saveKey(path, k.privateKey);
  } catch (err) {
    if (fsCode(err) === 'EEXIST') throw new LocalFailure('KEY_FILE_EXISTS', 'a key file already exists; it is never overwritten');
    fromFsError(err, 'key file');
  }
  await checkKeyFile(path, o);
  return { seed: k.privateKey, keyid: k.keyid };
}

/**
 * Every readable local seed under the profile root (all profiles; key, next and old files),
 * plus an explicit key file. Used by the redactor and the preflight; unreadable files are skipped.
 */
export async function allLocalSeeds(root: string, extraKeyFile: string | undefined, o: KeyOptions): Promise<Uint8Array[]> {
  const paths: string[] = [];
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    names = [];
  }
  for (const n of names.sort()) for (const f of [KEY_FILE, NEXT_KEY_FILE, OLD_KEY_FILE]) paths.push(join(root, n, f));
  if (extraKeyFile !== undefined) paths.push(extraKeyFile);
  const seeds: Uint8Array[] = [];
  for (const p of paths) {
    try {
      seeds.push(await loadKeyChecked(p, { ...o, trustPerms: true }));
    } catch {
      // missing, unreadable or invalid: nothing to protect
    }
  }
  return seeds;
}

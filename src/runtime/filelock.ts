// An exclusive lock file (DEC34: one donation at a time per wallet on this machine, across calls
// and processes). Created with O_EXCL (0600) holding {pid, at, nonce}.
//
// Taking over a stale lock (older than LOCK_STALE_MS, or its process is gone) never deletes a lock
// it did not judge: the file is first renamed to a name only this taker uses (rename is atomic,
// so exactly one taker gets it), then re-read. If it is no longer the lock that was judged stale
// (someone took over in between), it is put back with link(), which never replaces an existing
// lock. Release removes the lock only while it still holds our nonce, the same way. held()
// tells the holder whether the lock is still its own (checked again right before signing).
import { randomBytes } from 'node:crypto';
import { link, open, readFile, rename, rm, stat } from 'node:fs/promises';

export const LOCK_STALE_MS = 120_000;

interface LockBody {
  pid: number;
  at: number;
  nonce: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM';
  }
}

async function readBody(path: string): Promise<{ text: string; body: LockBody | null } | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const v = JSON.parse(text) as Partial<LockBody>;
    return { text, body: typeof v.pid === 'number' && typeof v.at === 'number' && typeof v.nonce === 'string' ? (v as LockBody) : null };
  } catch {
    return { text, body: null };
  }
}

async function isStale(path: string, seen: { text: string; body: LockBody | null }, nowMs: number): Promise<boolean> {
  if (seen.body !== null) return nowMs - seen.body.at > LOCK_STALE_MS || !alive(seen.body.pid);
  // partial (being written right now) or garbage: stale only once it is old
  try {
    return Date.now() - (await stat(path)).mtimeMs > 2_000;
  } catch {
    return false;
  }
}

async function tryTake(path: string, body: LockBody): Promise<boolean> {
  try {
    const fh = await open(path, 'wx', 0o600);
    try {
      await fh.writeFile(JSON.stringify(body));
    } finally {
      await fh.close();
    }
    return true;
  } catch (err) {
    if ((err as { code?: string }).code !== 'EEXIST') throw err;
    return false;
  }
}

/**
 * Removes the lock at `path` only if it is still exactly `expectedText`: renamed aside first
 * (atomic, one winner), compared, and put back with link() when it turned out to be another.
 * Returns true when the expected lock was removed.
 */
export async function removeIfUnchanged(path: string, expectedText: string): Promise<boolean> {
  const aside = `${path}.${randomBytes(8).toString('hex')}.aside`;
  try {
    await rename(path, aside);
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return false; // someone else got there first
    throw err;
  }
  let got = '';
  try {
    got = await readFile(aside, 'utf8');
  } catch {
    got = '';
  }
  if (got === expectedText) {
    await rm(aside, { force: true });
    return true;
  }
  // not the lock we judged: give it back unless a new lock exists by now (never replace one)
  try {
    await link(aside, path);
  } catch {
    // EEXIST: a newer lock is in place; the old holder will find held() false
  }
  await rm(aside, { force: true });
  return false;
}

export interface LockHandle {
  /** true while the lock file still holds this holder's nonce */
  held(): Promise<boolean>;
}

/** Runs fn holding the lock; null when it stayed busy for waitMs. */
export async function withFileLock<T>(path: string, fn: (h: LockHandle) => Promise<T>, opts: { waitMs?: number; now?: () => number } = {}): Promise<{ value: T } | null> {
  const now = opts.now ?? Date.now;
  const deadline = Date.now() + (opts.waitMs ?? 5_000);
  const mine: LockBody = { pid: process.pid, at: now(), nonce: randomBytes(16).toString('hex') };
  const mineText = JSON.stringify(mine);
  for (;;) {
    if (await tryTake(path, mine)) break;
    const seen = await readBody(path);
    if (seen !== null && (await isStale(path, seen, now()))) {
      await removeIfUnchanged(path, seen.text);
      continue;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 50 + Math.floor(Math.random() * 100)));
  }
  const handle: LockHandle = {
    async held() {
      const cur = await readBody(path);
      return cur !== null && cur.text === mineText;
    },
  };
  try {
    return { value: await fn(handle) };
  } finally {
    await removeIfUnchanged(path, mineText);
  }
}

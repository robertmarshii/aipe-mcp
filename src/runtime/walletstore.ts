// The donation record of one wallet on this machine (DEC34, review of 23852d1): every profile
// that uses the same wallet shares it, so the unattended limit (one donation per 30 days) and
// the unresolved payments are wallet-wide.
//
//   <AIPE_HOME root>/donations/            0700, never a symbolic link
//   <AIPE_HOME root>/donations/<0x...>.json 0600, never followed if it is a link; atomic writes
//   <AIPE_HOME root>/donations/<0x...>.lock the per-wallet lock (src/runtime/filelock.ts)
//
// The file holds no secret: settled (or possibly settled) times, and signed payments whose
// outcome is unknown, by place (environment|base URL). Every write re-reads the file and is
// done only while the caller still holds the wallet lock (CAS on a version counter as well).
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { LocalFailure } from './errors.ts';
import { UNATTENDED_WINDOW_MS } from './donation.ts';
import { withFileLock, type LockHandle } from './filelock.ts';

/** A signed donation whose outcome is not known yet (holds no key; it can only pay AIPE once). */
export interface PendingDonation {
  /** environment and base URL it was made for */
  place: string;
  header: string;
  offer_id: string | null;
  network: string;
  asset: string;
  amount: string;
  pay_to: string;
  payer: string;
  /** unix seconds: after this it can no longer be settled (only found, if it already was) */
  valid_before: number;
  at: number;
}

export interface WalletRecord {
  v: 1;
  /** bumped on every write (compare-and-swap) */
  version: number;
  /** times (ms) of donations that settled, or may have */
  ledger: number[];
  pending: Record<string, PendingDonation>;
}

const empty = (): WalletRecord => ({ v: 1, version: 0, ledger: [], pending: {} });

function storeError(why: string): LocalFailure {
  return new LocalFailure('LOCAL_DONATION_STORE', `the donation record cannot be used: ${why}; nothing was sent`);
}

export class WalletStore {
  readonly dir: string;
  readonly file: string;
  readonly lockFile: string;
  readonly #now: () => number;

  constructor(root: string, address: string, now: () => number) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw storeError('bad wallet address');
    this.dir = join(root, 'donations');
    const name = address.toLowerCase();
    this.file = join(this.dir, `${name}.json`);
    this.lockFile = join(this.dir, `${name}.lock`);
    this.#now = now;
  }

  /** Creates the folder (0700) if needed; refuses a link or a non-folder. */
  async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const st = await lstat(this.dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw storeError('the donations folder is a link or not a folder');
    if ((st.mode & 0o077) !== 0) await chmod(this.dir, 0o700);
  }

  async read(): Promise<WalletRecord> {
    try {
      const st = await lstat(this.dir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw storeError('the donations folder is a link or not a folder');
    } catch (err) {
      if (err instanceof LocalFailure) throw err;
      return empty(); // no folder yet: nothing recorded
    }
    let fh;
    try {
      fh = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT') return empty();
      if (code === 'ELOOP') throw storeError('the record is a link');
      throw storeError('it cannot be read');
    }
    let text: string;
    try {
      text = await fh.readFile('utf8');
    } finally {
      await fh.close();
    }
    let v: Partial<WalletRecord>;
    try {
      v = JSON.parse(text) as Partial<WalletRecord>;
    } catch {
      throw storeError('it is not valid JSON');
    }
    if (v.v !== 1 || typeof v.version !== 'number' || !Array.isArray(v.ledger) || v.pending === null || typeof v.pending !== 'object') throw storeError('unknown format');
    return { v: 1, version: v.version, ledger: v.ledger.filter((t): t is number => typeof t === 'number'), pending: v.pending as Record<string, PendingDonation> };
  }

  /**
   * One atomic step under the wallet lock: re-reads the record, gives up when the lock is no
   * longer ours, lets `change` decide (it returns a reason to stop, or edits the record), and
   * writes with a version check. Returns the stop reason, or null when written.
   */
  async update<S>(lock: LockHandle, change: (r: WalletRecord) => S | null): Promise<S | null> {
    if (!(await lock.held())) throw storeError('the wallet lock was lost');
    const r = await this.read();
    const before = r.version;
    const stop = change(r);
    if (stop !== null) return stop;
    const now = this.#now();
    r.ledger = r.ledger.filter((t) => now - t < UNATTENDED_WINDOW_MS || t > now);
    r.version = before + 1;
    const tmp = join(this.dir, `.${randomBytes(6).toString('hex')}.tmp`);
    const fh = await open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(`${JSON.stringify(r, null, 1)}\n`, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      // CAS: nobody wrote meanwhile, and the lock is still ours, right before the rename
      if ((await this.read()).version !== before || !(await lock.held())) throw storeError('the record changed meanwhile');
      await rename(tmp, this.file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return null;
  }

  /** Runs fn holding this wallet's lock (null: busy). */
  async locked<T>(fn: (lock: LockHandle) => Promise<T>): Promise<{ value: T } | null> {
    await this.ensureDir();
    return withFileLock(this.lockFile, fn, { now: this.#now });
  }
}

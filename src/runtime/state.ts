// Local state (plan §1.4): state.json holds no secret. Mode 0600, atomic write (temp file +
// rename), and re-read before every write so two writers never lose each other's changes.
import { randomBytes } from 'node:crypto';
import { chmod, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LocalFailure } from './errors.ts';

export type SeenSource = 'detail' | 'search' | 'inbox' | 'outbox';

export interface SeenEntry {
  sources: SeenSource[];
  /** SHA-256 of the canonical untrusted fields at the last detail read */
  hash: string | null;
  /** ms: last time seen; detail_at: last detail read */
  at: number;
  detail_at: number | null;
}

export interface PendingAnswer {
  kind: 'reasoning' | 'gate_challenge' | 'sandbox';
  /** the tool that handed it out */
  tool: string;
  expires_at: string | null;
  /** the challenge's answer_schema, for the local check before an attempt is used */
  answer_schema?: Record<string, unknown> | null;
  at: number;
}

export interface McpState {
  version: 1;
  environment?: string;
  agent_name?: string;
  registration?: { registration_id: string; nonce: string; expires_at: string } | null;
  agent_id?: string | null;
  project_id?: string | null;
  certificate?: { value: string; fp: string; expires_at: string } | null;
  sandbox?: unknown;
  /** the name the practice-run agent registered with (kept for resumes) */
  sandbox_agent_name?: string;
  live_prepared?: unknown;
  recovery?: { recovery_id: string; eligible_at: string; next_key_file: string } | null;
  seen: Record<string, SeenEntry>;
  /** Idempotency-Keys of calls still waiting for a final answer, per (tool, canonical args) */
  idem: Record<string, { key: string; at: number }>;
  /** last poll time (ms) per route */
  polls: Record<string, number>;
  /** retry_at (ms) per route */
  retry_at: Record<string, number>;
  /** every challenge or sandbox input this server handed out, by id (aipe_answer routing) */
  pending: Record<string, PendingAnswer>;
}

export const SEEN_TTL_MS = 24 * 3600 * 1000;
export const IDEM_TTL_MS = 24 * 3600 * 1000;

export function emptyState(): McpState {
  return { version: 1, seen: {}, idem: {}, polls: {}, retry_at: {}, pending: {} };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Drops expired entries; tolerates missing maps in older files. */
export function prune(s: McpState, nowMs: number): McpState {
  const out: McpState = { ...emptyState(), ...s };
  for (const k of ['seen', 'idem', 'polls', 'retry_at', 'pending'] as const) if (!isRecord(out[k])) (out as unknown as Record<string, unknown>)[k] = {};
  out.seen = Object.fromEntries(Object.entries(out.seen).filter(([, v]) => nowMs - v.at < SEEN_TTL_MS));
  out.idem = Object.fromEntries(Object.entries(out.idem).filter(([, v]) => nowMs - v.at < IDEM_TTL_MS));
  out.retry_at = Object.fromEntries(Object.entries(out.retry_at).filter(([, v]) => v > nowMs));
  out.pending = Object.fromEntries(
    Object.entries(out.pending).filter(([, v]) => v.expires_at === null || Date.parse(v.expires_at) + 60_000 > nowMs),
  );
  return out;
}

export class StateStore {
  readonly #path: string;
  readonly #now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.#path = path;
    this.#now = now;
  }

  async read(): Promise<McpState> {
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return emptyState();
      throw new LocalFailure('LOCAL_INTERNAL', 'the state file cannot be read');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new LocalFailure('LOCAL_INTERNAL', 'the state file is not valid JSON');
    }
    if (!isRecord(parsed) || parsed.version !== 1) throw new LocalFailure('LOCAL_INTERNAL', 'the state file has an unknown version');
    return prune(parsed as unknown as McpState, this.#now());
  }

  /** Re-reads, applies the change, writes atomically (0600). Returns the new state. */
  async update(change: (s: McpState) => void | McpState): Promise<McpState> {
    const current = await this.read();
    const next = change(current) ?? current;
    await this.#write(next);
    return next;
  }

  async #write(s: McpState): Promise<void> {
    const tmp = join(dirname(this.#path), `.state.${randomBytes(6).toString('hex')}.tmp`);
    const fh = await open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(`${JSON.stringify(s, null, 1)}\n`, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await chmod(tmp, 0o600);
      await rename(tmp, this.#path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }
}

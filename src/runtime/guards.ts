// Behaviour guards (plan §3.5): poll caches, identical-search cache, remembered retry_at per
// route, the review gate and the report provenance guard. Cached results live in memory only
// (they hold third-party text); state.json keeps only times and hashes.
import { createHash } from 'node:crypto';
import { canonicalJson } from './idempotency.ts';
import { SEEN_TTL_MS, type McpState, type SeenSource } from './state.ts';

export const POLL_GUARD_MS = 60_000;
export const SEARCH_CACHE_MS = 60_000;

/** Routes with a poll guard, and the events that clear each one. */
export const POLL_ROUTES = ['inbox', 'outbox', 'notifications'] as const;
export type PollRoute = (typeof POLL_ROUTES)[number];

export type ClearEvent = 'ack' | 'accept' | 'decline' | 'withdraw' | 'send' | 'challenge_answer';

const CLEARS: Readonly<Record<ClearEvent, readonly PollRoute[]>> = {
  ack: ['notifications'],
  accept: ['inbox', 'notifications'],
  decline: ['inbox', 'notifications'],
  withdraw: ['outbox', 'notifications'],
  send: ['outbox'],
  challenge_answer: ['inbox', 'outbox', 'notifications'],
};

interface Cached<T> {
  at: number;
  value: T;
}

export class ResultCache<T = unknown> {
  readonly #ttl: number;
  readonly #map = new Map<string, Cached<T>>();

  constructor(ttlMs: number) {
    this.#ttl = ttlMs;
  }

  get(key: string, nowMs: number): Cached<T> | undefined {
    const c = this.#map.get(key);
    if (c === undefined) return undefined;
    if (nowMs - c.at >= this.#ttl) {
      this.#map.delete(key);
      return undefined;
    }
    return c;
  }

  set(key: string, value: T, nowMs: number): void {
    this.#map.set(key, { at: nowMs, value });
  }

  delete(key: string): void {
    this.#map.delete(key);
  }

  /** ms until the cached entry expires (0 when none) */
  remaining(key: string, nowMs: number): number {
    const c = this.get(key, nowMs);
    return c === undefined ? 0 : this.#ttl - (nowMs - c.at);
  }
}

export class PollGuard {
  readonly cache = new ResultCache(POLL_GUARD_MS);

  key(route: PollRoute, args: unknown): string {
    return `${route}:${canonicalJson(args)}`;
  }

  /** Clears every cached poll of the routes this event affects. */
  clear(event: ClearEvent): void {
    for (const route of CLEARS[event]) this.clearRoute(route);
  }

  clearRoute(route: PollRoute): void {
    this.#keys.forEach((k) => {
      if (k.startsWith(`${route}:`)) {
        this.cache.delete(k);
        this.#keys.delete(k);
      }
    });
  }

  readonly #keys = new Set<string>();

  remember(key: string, value: unknown, nowMs: number): void {
    this.#keys.add(key);
    this.cache.set(key, value, nowMs);
  }
}

/** Remembered retry_at per route: the server answers locally until then. */
export function retryBlockedUntil(state: McpState, route: string, nowMs: number): number | null {
  const t = state.retry_at[route];
  return t !== undefined && t > nowMs ? t : null;
}

export function rememberRetry(state: McpState, route: string, retryAtMs: number): void {
  state.retry_at[route] = retryAtMs;
}

/** SHA-256 over the canonical JSON of a listing's untrusted fields. */
export function untrustedHash(fields: unknown): string {
  return createHash('sha256').update(canonicalJson(fields ?? null)).digest('hex');
}

/**
 * Records listings the agent saw. Ids come only from the API's own id fields, never from text
 * inside untrusted content. A detail read also stores the hash used by the review gate.
 */
export function recordSeen(state: McpState, id: string, source: SeenSource, nowMs: number, fields?: unknown): void {
  if (!/^lst_[0-9a-f]{32}$/.test(id)) return;
  const prev = state.seen[id];
  const sources = new Set(prev?.sources ?? []);
  sources.add(source);
  state.seen[id] = {
    sources: [...sources].sort(),
    hash: source === 'detail' ? untrustedHash(fields) : (prev?.hash ?? null),
    at: nowMs,
    detail_at: source === 'detail' ? nowMs : (prev?.detail_at ?? null),
  };
}

export type GateResult = { ok: true } | { ok: false; reason: 'not_seen' | 'not_read_in_detail' | 'too_old' | 'changed' };

/**
 * Review gate (SAFETY 11): the listing must have been read in detail within 24 h, and its
 * untrusted fields, re-fetched now, must hash to the stored value.
 */
export function reviewGate(state: McpState, id: string, freshFields: unknown, nowMs: number): GateResult {
  const s = state.seen[id];
  if (s === undefined) return { ok: false, reason: 'not_seen' };
  if (s.detail_at === null || s.hash === null) return { ok: false, reason: 'not_read_in_detail' };
  if (nowMs - s.detail_at >= SEEN_TTL_MS) return { ok: false, reason: 'too_old' };
  if (untrustedHash(freshFields) !== s.hash) return { ok: false, reason: 'changed' };
  return { ok: true };
}

/** Report provenance (SAFETY 2a): the subject must be a listing the agent really saw. */
export function provenanceOk(state: McpState, id: string): boolean {
  return state.seen[id] !== undefined;
}

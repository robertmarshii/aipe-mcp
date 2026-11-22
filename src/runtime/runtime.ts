// The per-process runtime shared by every tool: config, keys, state, SDK clients, caches.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient, fetchTransport, type AipeClient, type Transport } from 'aipe-sdk';
import { USER_AGENT } from '../version.ts';
import type { Config } from './config.ts';
import { ActivityClock, CONFIRM_FILE, TokenBook } from './confirm.ts';
import { ATTEMPT_TIMEOUT_MS, wrapTransport } from './deadline.ts';
import { LocalFailure } from './errors.ts';
import { PollGuard, ResultCache, SEARCH_CACHE_MS } from './guards.ts';
import { allLocalSeeds, loadKeyChecked, type KeyOptions } from './keystore.ts';
import type { Logger } from './log.ts';
import type { SeedSource } from './redact.ts';
import { StateStore } from './state.ts';

export const CLIENT_OPTIONS = { maxAttempts: 4, maxRetryWaitSeconds: 20, timeoutMs: ATTEMPT_TIMEOUT_MS } as const;

export interface CurrentKey {
  seed: Uint8Array;
  keyid: string;
}

/** Holds the local seeds the redactor and preflight protect, refreshed when keys change. */
export class KeyRing implements SeedSource {
  readonly #cfg: Config;
  #seeds: Uint8Array[] = [];

  constructor(cfg: Config) {
    this.#cfg = cfg;
  }

  get options(): KeyOptions {
    return { trustPerms: this.#cfg.trustPerms, platform: this.#cfg.platform };
  }

  /** the agent keys, plus the owner's donation wallet key (1.0.4), which is never refreshed away */
  seeds(): readonly Uint8Array[] {
    const w = this.#cfg.donationWallet;
    return w === undefined ? this.#seeds : [...this.#seeds, w.redactionSeed()];
  }

  add(seed: Uint8Array): void {
    this.#seeds = [...this.#seeds, seed];
  }

  async refresh(): Promise<void> {
    this.#seeds = await allLocalSeeds(this.#cfg.root, this.#cfg.explicitKeyFile, this.options);
  }

  /** The profile's current key, or null when there is none yet. Other key-file problems throw. */
  async current(): Promise<CurrentKey | null> {
    let seed: Uint8Array;
    try {
      seed = await loadKeyChecked(this.#cfg.keyFile, this.options);
    } catch (err) {
      if (err instanceof LocalFailure && err.code === 'KEY_FILE_MISSING') return null;
      throw err;
    }
    if (!this.#seeds.some((s) => Buffer.from(s).equals(Buffer.from(seed)))) this.add(seed);
    const keyid = createClient({ environment: 'sandbox', privateKey: seed }).keyid as string;
    return { seed, keyid };
  }
}

export interface Runtime {
  cfg: Config;
  log: Logger;
  now: () => number;
  keys: KeyRing;
  state: StateStore;
  tokens: TokenBook;
  /** DEC31: tool-call activity, for the owner-approval rule of the token path */
  activity: ActivityClock;
  /** per-process secret that seals elicitation answers carried in requestState */
  stateSecret: Buffer;
  /** spent elicitation-round nonces (2026-07-28 requestState), with their expiry */
  elicitSpent: Map<string, number>;
  polls: PollGuard;
  searches: ResultCache;
  transport: Transport;
  /** the client for AIPE_ENV (live by default) */
  mainClient(seed: Uint8Array | undefined): AipeClient;
  /** a client for quick checks: one attempt, 5 s timeout (the key switch probe) */
  probeClient(seed: Uint8Array): AipeClient;
  /** the client for the practice sandbox (certification always runs there) */
  sandboxClient(seed: Uint8Array | undefined): AipeClient;
}

export function makeRuntime(cfg: Config, log: Logger, opts: { now?: () => number; transport?: Transport } = {}): Runtime {
  const now = opts.now ?? Date.now;
  const transport = wrapTransport(opts.transport ?? fetchTransport, USER_AGENT, now);
  // test only: the local stack's test clock (signatures must carry the stack's time)
  const clockFile = cfg.testClockFile;
  const clock =
    clockFile === undefined
      ? undefined
      : () => {
          let offset = 0;
          try {
            offset = Number(readFileSync(clockFile, 'utf8').trim()) || 0;
          } catch {
            offset = 0;
          }
          return Math.floor((Date.now() + offset) / 1000);
        };
  const base = { ...CLIENT_OPTIONS, transport, ...(clock === undefined ? {} : { clock }) };
  return {
    cfg,
    log,
    now,
    keys: new KeyRing(cfg),
    state: new StateStore(cfg.stateFile, now),
    // the HMAC key lives in the profile (0600), so a confirmation survives a restart
    tokens: new TokenBook(now, { file: join(cfg.profileDir, CONFIRM_FILE) }),
    activity: new ActivityClock(now),
    stateSecret: randomBytes(32),
    elicitSpent: new Map(),
    polls: new PollGuard(),
    searches: new ResultCache(SEARCH_CACHE_MS),
    transport,
    mainClient(seed) {
      return createClient({
        ...base,
        environment: cfg.env,
        ...(cfg.baseUrl === undefined ? {} : { baseUrl: cfg.baseUrl }),
        ...(seed === undefined ? {} : { privateKey: seed }),
      });
    },
    probeClient(seed) {
      return createClient({
        ...base,
        maxAttempts: 1,
        timeoutMs: 5_000,
        environment: cfg.env,
        ...(cfg.baseUrl === undefined ? {} : { baseUrl: cfg.baseUrl }),
        privateKey: seed,
      });
    },
    sandboxClient(seed) {
      return createClient({
        ...base,
        environment: 'sandbox',
        ...(cfg.sandboxUrl === undefined ? {} : { baseUrl: cfg.sandboxUrl }),
        ...(seed === undefined ? {} : { privateKey: seed }),
      });
    },
  };
}

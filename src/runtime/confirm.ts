// Confirmation (plan §3.4, DEC31) and the possible-secret question (§3.3 step 4).
//
// Levels (AIPE_CONFIRM, DEC31 22 Nov 2026):
//   agent (default): the agent trades on its own. Only the high-risk gates stay: H tools (report,
//     key recover, recovery cancel; offer accept with AIPE_CONFIRM_ACCEPT=owner) and tools marked
//     highRisk (deleting the project);
//   owner ("ask me first"; `standard` is its older name and means the same): every committing
//     tool asks the owner, and accepting an offer becomes an H tool;
//   strict: owner, plus decline, withdraw offer, rules accept and activate, and H tools are
//     refused without elicitation;
//   off: nothing is confirmed (unattended tests only).
//
// Mechanisms (AIPE_CONFIRM_VIA=auto|elicit|token):
//   1. elicitation, best effort, when the client declares it (about 90 s; a timeout or a missing
//      UI is LOCAL_NO_HUMAN_ANSWER, explicitly not a no);
//   2. the token path, for non-H tools only: confirmation_required with an HMAC token over the
//      tool, its canonical arguments and an expiry (10 min), single use. Owner approval is
//      enforced (DEC31): a token is only redeemed after the agent paused for its owner (no tool
//      call for OWNER_PAUSE_MS) or the MCP server restarted, so it cannot be redeemed in the
//      same turn it was issued. The HMAC key and the spent nonces live in the profile
//      (confirm.json, 0600), so a token survives a restart; when that file cannot be used, a
//      token from before the restart is refused as LOCAL_CONFIRM_RESTARTED ("ask again");
//   3. H tools: no token, ever. Without elicitation they rely on destructiveHint and the
//      client's own per-tool approval. A possible secret never gets a token either.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { adviceFor } from '../content/advice.ts';
import type { ConfirmLevelSetting, ConfirmVia } from './config.ts';
import type { ErrorResult } from './errors.ts';
import { canonicalJson } from './idempotency.ts';
import { quoteForElicitation } from './sanitise.ts';

export const TOKEN_TTL_MS = 10 * 60 * 1000;
export const ELICIT_TIMEOUT_MS = 90_000;
/** DEC31: the pause in tool calls that shows the agent stopped to wait for its owner. */
export const OWNER_PAUSE_MS = 20_000;
export const CONFIRM_FILE = 'confirm.json';
export const WAITING_TEXT = "Waiting for your owner's answer. If you see no prompt, your app may not support it.";
export const TOKEN_NEXT =
  'Ask your owner first: show them the summary and end your turn. Only after they agree, in a later message, call the same tool again with the same arguments plus confirm_token. Never approve it yourself: the token is refused in the same turn it was issued.';

export type ElicitOutcome = 'accept' | 'decline' | 'cancel' | 'timeout';

/** What the transport layer can do for one tool call. */
export interface ElicitPort {
  canElicit: boolean;
  /**
   * Asks the human. Resolves with the outcome, or with `defer` (2026-07-28 clients): the
   * handler must return that value; the client asks the human and calls the tool again.
   */
  ask(key: string, message: string): Promise<ElicitOutcome | { defer: unknown }>;
}

export interface ConfirmSpec {
  name: string;
  confirm: 'standard' | 'strict' | 'never';
  confirmLiveOnly?: true;
  human: boolean;
  /** DEC31: keeps its gate under the default AIPE_CONFIRM=agent */
  highRisk?: true;
}

export interface ConfirmationRequired {
  status: 'confirmation_required';
  summary: string;
  confirm_token: string;
  expires_at: string;
  next: string;
}

export type GateDecision = { proceed: true } | { proceed: false; result: ErrorResult | ConfirmationRequired } | { proceed: false; defer: unknown };

export function needsConfirmation(spec: ConfirmSpec, level: ConfirmLevelSetting, env: string): boolean {
  if (level === 'off') return false;
  if (spec.confirmLiveOnly === true && env !== 'live') return false;
  if (spec.human) return true;
  if (spec.highRisk === true) return true;
  if (level === 'agent') return false;
  if (spec.confirm === 'standard') return true;
  return spec.confirm === 'strict' && level === 'strict';
}

function localError(code: string, message: string): ErrorResult {
  return { status: 'error', code, http_status: null, message, retryable: false, request_id: null, what_to_do: adviceFor(code) };
}

/**
 * DEC31: tracks tool-call activity in this process, so the token path can tell whether the
 * agent stopped and waited for its owner since a token was issued. A call that starts while no
 * other call is running, at least OWNER_PAUSE_MS after the last activity, marks a pause. A
 * restart (this process started after the token was issued) counts as a pause too.
 */
export class ActivityClock {
  readonly startedAt: number;
  readonly #now: () => number;
  #last: number;
  #inFlight = 0;
  #lastPause = Number.NEGATIVE_INFINITY;

  constructor(now: () => number = Date.now) {
    this.#now = now;
    this.startedAt = now();
    this.#last = this.startedAt;
  }

  begin(): void {
    const t = this.#now();
    if (this.#inFlight === 0 && t - this.#last >= OWNER_PAUSE_MS) this.#lastPause = t;
    this.#inFlight += 1;
    this.#last = t;
  }

  end(): void {
    this.#inFlight = Math.max(0, this.#inFlight - 1);
    this.#last = this.#now();
  }

  /** true when the owner had a chance to answer after `issuedAt`. */
  pausedSince(issuedAt: number): boolean {
    return this.startedAt > issuedAt || this.#lastPause > issuedAt;
  }
}

export type TokenCheck = { ok: true; nonce: string; exp: number; issuedAt: number } | { ok: false; reason: 'invalid' | 'restarted' };

interface ConfirmFile {
  v: 1;
  key: string;
  used: Record<string, number>;
}

/**
 * Single-use HMAC tokens bound to tool + canonical arguments + expiry. With a file (the
 * profile's confirm.json, 0600), the key and the spent nonces survive a restart; without one, or
 * when the file cannot be used, they live in memory only.
 */
export class TokenBook {
  readonly #now: () => number;
  readonly #file: string | undefined;
  readonly #createdAt: number;
  #secret: Buffer | undefined;
  #persisted = false;
  #used = new Map<string, number>();

  constructor(now: () => number = Date.now, opts: { secret?: Buffer; file?: string } = {}) {
    this.#now = now;
    this.#file = opts.file;
    this.#secret = opts.secret;
    this.#createdAt = now();
  }

  /** true when the key is kept in the profile (tokens survive a restart). */
  get persisted(): boolean {
    this.#key();
    return this.#persisted;
  }

  /** Only called when there is a file. */
  #readFile(): ConfirmFile | null {
    const file = this.#file as string;
    try {
      if (lstatSync(file).isSymbolicLink()) return null;
      const f = JSON.parse(readFileSync(file, 'utf8')) as ConfirmFile;
      if (f.v !== 1 || typeof f.key !== 'string' || Buffer.from(f.key, 'base64').length !== 32) return null;
      if (f.used === null || typeof f.used !== 'object' || Array.isArray(f.used)) f.used = {};
      return f;
    } catch {
      return null;
    }
  }

  #writeFile(f: ConfirmFile, exclusive: boolean): void {
    const file = this.#file as string;
    const text = `${JSON.stringify(f)}\n`;
    if (exclusive) {
      writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
      return;
    }
    const tmp = join(dirname(file), `.confirm.${randomBytes(6).toString('hex')}.tmp`);
    try {
      writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }

  #key(): Buffer {
    if (this.#secret !== undefined) return this.#secret;
    if (this.#file !== undefined) {
      try {
        let f = this.#readFile();
        if (f === null) {
          mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
          try {
            this.#writeFile({ v: 1, key: randomBytes(32).toString('base64'), used: {} }, true);
          } catch (err) {
            if ((err as { code?: string }).code !== 'EEXIST') throw err;
          }
          f = this.#readFile();
        }
        if (f !== null) {
          this.#secret = Buffer.from(f.key, 'base64');
          this.#persisted = true;
          return this.#secret;
        }
      } catch {
        // the profile cannot hold the file: memory only (a restart then says "ask again")
      }
    }
    this.#secret = randomBytes(32);
    return this.#secret;
  }

  #mac(tool: string, args: unknown, exp: number, nonce: string): string {
    return createHmac('sha256', this.#key()).update(`${tool}\n${canonicalJson(args)}\n${exp}\n${nonce}`).digest('base64url');
  }

  #isUsed(nonce: string): boolean {
    if (this.#persisted) {
      const f = this.#readFile();
      if (f !== null) for (const [n, e] of Object.entries(f.used)) this.#used.set(n, e);
    }
    return this.#used.has(nonce);
  }

  issue(tool: string, args: unknown): { token: string; expiresAt: number } {
    const exp = this.#now() + TOKEN_TTL_MS;
    const nonce = randomBytes(12).toString('base64url');
    return { token: `v1.${exp}.${nonce}.${this.#mac(tool, args, exp, nonce)}`, expiresAt: exp };
  }

  /** Checks a token without spending it. */
  check(tool: string, args: unknown, token: string): TokenCheck {
    const m = /^v1\.(\d{1,15})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (m === null) return { ok: false, reason: 'invalid' };
    const exp = Number(m[1]);
    const nonce = m[2] as string;
    const issuedAt = exp - TOKEN_TTL_MS;
    const want = Buffer.from(this.#mac(tool, args, exp, nonce));
    const got = Buffer.from(m[3] as string);
    if (want.length !== got.length || !timingSafeEqual(want, got)) {
      // an unexpired token from before this process started, with a key that did not survive
      const restarted = !this.#persisted && issuedAt < this.#createdAt && exp > this.#now();
      return { ok: false, reason: restarted ? 'restarted' : 'invalid' };
    }
    if (exp <= this.#now() || this.#isUsed(nonce)) return { ok: false, reason: 'invalid' };
    return { ok: true, nonce, exp, issuedAt };
  }

  /** Spends a checked token (single use; remembered in the profile when it is kept there). */
  spend(c: { nonce: string; exp: number }): void {
    const now = this.#now();
    this.#used.set(c.nonce, c.exp);
    for (const [n, e] of this.#used) if (e <= now) this.#used.delete(n);
    if (!this.#persisted) return;
    try {
      const f = this.#readFile();
      if (f === null) return;
      const used: Record<string, number> = {};
      for (const [n, e] of [...Object.entries(f.used), ...this.#used]) if (e > now) used[n] = e;
      this.#writeFile({ v: 1, key: f.key, used }, false);
    } catch {
      // still spent in memory
    }
  }
}

export interface GateInput {
  spec: ConfirmSpec;
  level: ConfirmLevelSetting;
  via: ConfirmVia;
  env: string;
  /** the tool arguments without confirm_token */
  args: Record<string, unknown>;
  confirmToken: string | undefined;
  /** static text plus quoted, capped untrusted text only */
  summary: string;
  port: ElicitPort;
  tokens: TokenBook;
  activity: ActivityClock;
}

function tokenPath(i: GateInput): GateDecision {
  if (i.confirmToken !== undefined) {
    const c = i.tokens.check(i.spec.name, i.args, i.confirmToken);
    if (!c.ok) {
      return c.reason === 'restarted'
        ? { proceed: false, result: localError('LOCAL_CONFIRM_RESTARTED', 'the MCP server restarted since this confirmation was issued; ask again') }
        : { proceed: false, result: localError('LOCAL_CONFIRM_INVALID', 'the confirmation is not valid for this call') };
    }
    // DEC31: owner approval is enforced; the token stays valid for the owner's real answer
    if (!i.activity.pausedSince(c.issuedAt)) {
      return { proceed: false, result: localError('LOCAL_CONFIRM_TOO_SOON', "this confirmation needs your owner's answer first; nothing was sent") };
    }
    i.tokens.spend(c);
    return { proceed: true };
  }
  const t = i.tokens.issue(i.spec.name, i.args);
  return {
    proceed: false,
    result: {
      status: 'confirmation_required',
      summary: i.summary,
      confirm_token: t.token,
      expires_at: new Date(t.expiresAt).toISOString(),
      next: TOKEN_NEXT,
    },
  };
}

async function askHuman(i: GateInput): Promise<ElicitOutcome | { defer: unknown }> {
  return i.port.ask('confirm', `${i.summary}\n\n${WAITING_TEXT}`);
}

const NO_ANSWER = (): GateDecision => ({ proceed: false, result: localError('LOCAL_NO_HUMAN_ANSWER', 'no answer from the owner (not a no)') });
const DECLINED = (): GateDecision => ({ proceed: false, result: localError('LOCAL_OWNER_DECLINED', 'the approval request was declined in the app; nothing was sent') });

export async function confirmGate(i: GateInput): Promise<GateDecision> {
  if (!needsConfirmation(i.spec, i.level, i.env)) return { proceed: true };

  if (i.spec.human) {
    // H tools never use a token, so AIPE_CONFIRM_VIA=token cannot stop them from asking the owner
    if (!i.port.canElicit) {
      if (i.level === 'strict' || i.via === 'elicit') {
        return { proceed: false, result: localError('LOCAL_NEEDS_HUMAN_UI', 'this action needs approval in a client that can ask the owner') };
      }
      return { proceed: true }; // destructiveHint + the client's own per-tool approval
    }
    const r = await askHuman(i);
    if (typeof r === 'object') return { proceed: false, defer: r.defer };
    if (r === 'accept') return { proceed: true };
    // cancel (dismissed, or no UI) and timeout are not a no
    return r === 'decline' ? DECLINED() : NO_ANSWER();
  }

  const elicitAllowed = i.via !== 'token' && i.port.canElicit;
  if (!elicitAllowed) {
    if (i.via === 'elicit') {
      return { proceed: false, result: localError('LOCAL_NEEDS_HUMAN_UI', 'AIPE_CONFIRM_VIA=elicit but this client cannot ask the owner') };
    }
    return tokenPath(i);
  }
  if (i.confirmToken !== undefined && i.via === 'auto') return tokenPath(i);
  const r = await askHuman(i);
  if (typeof r === 'object') return { proceed: false, defer: r.defer };
  if (r === 'accept') return { proceed: true };
  if (r === 'decline') return DECLINED();
  // cancel or timeout: no answer (not a no); under auto the token path is the fallback
  return i.via === 'elicit' ? NO_ANSWER() : tokenPath(i);
}

/**
 * Possible secret in outgoing text (§3.3 step 4, rev 3): ask the owner directly when the client
 * can; otherwise, or on decline or timeout, refuse. Never a token.
 */
export async function confirmPossibleSecret(port: ElicitPort, field: string, text: string, via: ConfirmVia): Promise<GateDecision> {
  const refuse: GateDecision = {
    proceed: false,
    result: localError('LOCAL_SECRET_IN_TEXT', `the field ${field} contains something that looks like a secret; nothing was sent`),
  };
  if (via === 'token' || !port.canElicit) return refuse;
  const r = await port.ask(
    'possible_secret',
    `The text in the field "${field}" contains something that looks like a password, token or key: ${quoteForElicitation(text)}. It is about to be sent and may be public. Send it anyway?\n\n${WAITING_TEXT}`,
  );
  if (typeof r === 'object') return { proceed: false, defer: r.defer };
  return r === 'accept' ? { proceed: true } : refuse;
}

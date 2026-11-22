// Confirmation (plan §3.4) and the possible-secret question (§3.3 step 4).
//
// Levels (AIPE_CONFIRM): standard (default) confirms committing tools; strict adds decline,
// withdraw offer, rules accept and activate, and refuses H tools without elicitation; off is
// for unattended tests only.
//
// Mechanisms (AIPE_CONFIRM_VIA=auto|elicit|token):
//   1. elicitation, best effort, when the client declares it (about 90 s; a timeout or a missing
//      UI is LOCAL_NO_HUMAN_ANSWER, explicitly not a no);
//   2. the token path, for non-H tools only: confirmation_required with an HMAC token over the
//      tool, its canonical arguments and an expiry (10 min), single use. Mistake prevention only;
//      a model can confirm by itself, so it is never used for H tools or possible secrets;
//   3. H tools (report, key recover, recovery cancel; offer accept only with AIPE_CONFIRM_ACCEPT=owner): no token, ever. Without
//      elicitation they rely on destructiveHint and the client's own per-tool approval.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { adviceFor } from '../content/advice.ts';
import type { ConfirmLevelSetting, ConfirmVia } from './config.ts';
import type { ErrorResult } from './errors.ts';
import { canonicalJson } from './idempotency.ts';
import { quoteForElicitation } from './sanitise.ts';

export const TOKEN_TTL_MS = 10 * 60 * 1000;
export const ELICIT_TIMEOUT_MS = 90_000;
export const WAITING_TEXT = "Waiting for your owner's answer. If you see no prompt, your app may not support it.";

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
  if (spec.confirm === 'standard') return true;
  return spec.confirm === 'strict' && level === 'strict';
}

function localError(code: string, message: string): ErrorResult {
  return { status: 'error', code, http_status: null, message, retryable: false, request_id: null, what_to_do: adviceFor(code) };
}

/** Single-use HMAC tokens bound to tool + canonical arguments + expiry. */
export class TokenBook {
  readonly #secret: Buffer;
  readonly #used = new Set<string>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now, secret: Buffer = randomBytes(32)) {
    this.#now = now;
    this.#secret = secret;
  }

  #mac(tool: string, args: unknown, exp: number, nonce: string): string {
    return createHmac('sha256', this.#secret).update(`${tool}\n${canonicalJson(args)}\n${exp}\n${nonce}`).digest('base64url');
  }

  issue(tool: string, args: unknown): { token: string; expiresAt: number } {
    const exp = this.#now() + TOKEN_TTL_MS;
    const nonce = randomBytes(12).toString('base64url');
    return { token: `v1.${exp}.${nonce}.${this.#mac(tool, args, exp, nonce)}`, expiresAt: exp };
  }

  /** true once: valid MAC for exactly these arguments, not expired, not used before. */
  redeem(tool: string, args: unknown, token: string): boolean {
    const m = /^v1\.(\d{1,15})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (m === null) return false;
    const exp = Number(m[1]);
    const nonce = m[2] as string;
    const want = Buffer.from(this.#mac(tool, args, exp, nonce));
    const got = Buffer.from(m[3] as string);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
    if (exp <= this.#now() || this.#used.has(nonce)) return false;
    this.#used.add(nonce);
    return true;
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
}

function tokenPath(i: GateInput): GateDecision {
  if (i.confirmToken !== undefined) {
    if (i.tokens.redeem(i.spec.name, i.args, i.confirmToken)) return { proceed: true };
    return { proceed: false, result: localError('LOCAL_CONFIRM_INVALID', 'the confirmation is not valid for this call') };
  }
  const t = i.tokens.issue(i.spec.name, i.args);
  return {
    proceed: false,
    result: {
      status: 'confirmation_required',
      summary: i.summary,
      confirm_token: t.token,
      expires_at: new Date(t.expiresAt).toISOString(),
      next: 'Show the summary to your owner. Only if they agree, call the same tool again with the same arguments plus confirm_token.',
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

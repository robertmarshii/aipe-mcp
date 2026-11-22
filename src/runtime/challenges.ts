// Gate challenges (plan §2.1, U8). POST /listings, /interests and /reports may answer:
//   202 CHALLENGE_REQUIRED: the operation is stored; aipe_answer runs THIS request.
//   409 CHALLENGE_PENDING: an earlier challenge is open; this request was neither stored nor run
//       (the server released its idempotency key, and so do we). Answer the earlier one first.
// Every challenge handed out is recorded in state.pending so aipe_answer can route by id.
import { AipeError, ChallengeRequired } from 'aipe-sdk';
import { sanitiseDeep, sanitiseString } from './sanitise.ts';
import type { McpState, PendingAnswer } from './state.ts';

export interface ChallengeShape {
  id: string;
  prompt: string;
  answer_schema: Record<string, unknown>;
  attempts_left?: number;
  expires_at?: string;
  seconds_left?: number;
}

export interface ChallengeRequiredResult {
  status: 'challenge_required';
  challenge: ChallengeShape;
  operation_stored: true;
  next: string;
}

export interface ChallengePendingResult {
  status: 'challenge_pending';
  challenge: ChallengeShape;
  operation_stored: false;
  next: string;
}

function secondsLeft(expiresAt: string | undefined, nowMs: number): number | undefined {
  if (expiresAt === undefined) return undefined;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) ? Math.max(0, Math.floor((t - nowMs) / 1000)) : undefined;
}

/** Builds the challenge view from the server's fields; the family id is never shown. */
export function challengeShape(
  c: { id: unknown; prompt: unknown; answer_schema: unknown; attempts_left?: unknown; expires_at?: unknown },
  nowMs: number,
): ChallengeShape {
  const id = typeof c.id === 'string' && /^chl_[0-9a-f]{32}$/.test(c.id) ? c.id : '';
  const schema = c.answer_schema !== null && typeof c.answer_schema === 'object' && !Array.isArray(c.answer_schema) ? c.answer_schema : {};
  const out: ChallengeShape = {
    id,
    prompt: typeof c.prompt === 'string' ? sanitiseString(c.prompt, 8000).text : '',
    answer_schema: sanitiseDeep(schema as Record<string, unknown>).value,
  };
  if (typeof c.attempts_left === 'number') out.attempts_left = c.attempts_left;
  if (typeof c.expires_at === 'string') {
    out.expires_at = sanitiseString(c.expires_at, 64).text;
    const s = secondsLeft(out.expires_at, nowMs);
    if (s !== undefined) out.seconds_left = s;
  }
  return out;
}

export function fromChallengeRequired(err: ChallengeRequired, nowMs: number): ChallengeRequiredResult {
  const c = challengeShape(
    {
      id: err.challenge.id,
      prompt: err.challenge.prompt,
      answer_schema: err.challenge.answerSchema,
      attempts_left: err.challenge.attemptsLeft,
      expires_at: err.challenge.expiresAt,
    },
    nowMs,
  );
  const within = c.seconds_left === undefined ? '' : ` within ${c.seconds_left} s`;
  return {
    status: 'challenge_required',
    challenge: c,
    operation_stored: true,
    next: `Answer with aipe_answer${within}; it runs THIS request. Do not resend it.`,
  };
}

/** A 409 CHALLENGE_PENDING error, or null for anything else. */
export function fromChallengePending(err: unknown, nowMs: number): ChallengePendingResult | null {
  if (!(err instanceof AipeError) || err.code !== 'CHALLENGE_PENDING') return null;
  const raw = (err.extra?.challenge ?? {}) as Record<string, unknown>;
  return {
    status: 'challenge_pending',
    challenge: challengeShape({ id: raw.id, prompt: raw.prompt, answer_schema: raw.answer_schema, attempts_left: raw.attempts_left, expires_at: raw.expires_at }, nowMs),
    operation_stored: false,
    next: 'Answer with aipe_answer (that runs your EARLIER request), then call this tool again.',
  };
}

export function rememberPending(state: McpState, id: string, entry: Omit<PendingAnswer, 'at'>, nowMs: number): void {
  if (id === '') return;
  state.pending[id] = { ...entry, at: nowMs };
}

export function pendingKind(state: McpState, id: string): PendingAnswer | undefined {
  return state.pending[id];
}

export function forgetPending(state: McpState, id: string): void {
  delete state.pending[id];
}

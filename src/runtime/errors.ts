// Error normaliser (plan §2.4). Every failure a tool can meet becomes one plain object with a
// static what_to_do; unknown codes fall back to a generic entry. Server text is passed through
// the sanitiser and capped; nothing from a third party reaches what_to_do.
import { AipeError, TransportRefused } from 'aipe-sdk';
import { adviceFor } from '../content/advice.ts';
import { sanitiseString } from './sanitise.ts';

export interface ErrorResult {
  status: 'error';
  code: string;
  http_status: number | null;
  message: string;
  retryable: boolean;
  retry_after_seconds?: number;
  retry_at?: string;
  missing_step?: string;
  field?: string;
  hint?: string;
  reason?: string;
  request_id: string | null;
  what_to_do: string;
  [extra: string]: unknown;
}

/** A failure raised by the MCP server itself (codes LOCAL_*, KEY_FILE_*, INPUT_EXPIRED). */
export class LocalFailure extends Error {
  readonly code: string;
  readonly extra: Record<string, unknown>;
  readonly retryable: boolean;
  constructor(code: string, message: string, opts: { retryable?: boolean; extra?: Record<string, unknown> } = {}) {
    super(message);
    this.name = 'LocalFailure';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.extra = opts.extra ?? {};
  }
}

/** Extension members of an API problem that are copied (sanitised) into the result. */
const PASS_EXTRA = ['missing_step', 'hint', 'reason', 'closable_at', 'closes_at', 'locked_until', 'challenges_left', 'limit_scope'] as const;

function str(v: unknown, max = 500): string | undefined {
  return typeof v === 'string' ? sanitiseString(v, max).text : undefined;
}

export interface NormaliseContext {
  nowMs: number;
  /** true when the current tool call's deadline refused a new attempt */
  deadlineHit?: boolean;
}

export function normaliseError(err: unknown, ctx: NormaliseContext): ErrorResult {
  if (err instanceof LocalFailure) {
    const out: ErrorResult = {
      status: 'error',
      code: err.code,
      http_status: null,
      message: err.message,
      retryable: err.retryable,
      request_id: null,
      what_to_do: adviceFor(err.code),
    };
    for (const [k, v] of Object.entries(err.extra)) if (!(k in out)) out[k] = v;
    return out;
  }
  if (err instanceof TransportRefused) {
    const code = ctx.deadlineHit === true ? 'LOCAL_DEADLINE' : 'TRANSPORT_REFUSED';
    return {
      status: 'error',
      code,
      http_status: null,
      message: code === 'LOCAL_DEADLINE' ? 'the tool-call deadline passed before the service answered' : 'request refused before sending',
      retryable: code === 'LOCAL_DEADLINE',
      request_id: null,
      what_to_do: adviceFor(code),
    };
  }
  if (err instanceof AipeError) {
    const extra = err.extra ?? {};
    // SDK-local errors (status 0) carry their reason as the message; API errors put the server's
    // message after "CODE (HTTP n): "
    const serverMessage = err.status === 0 ? str(err.message) : err.message.includes(': ') ? str(err.message.slice(err.message.indexOf(': ') + 2)) : undefined;
    const out: ErrorResult = {
      status: 'error',
      code: /^[A-Z0-9_]{1,64}$/.test(err.code) ? err.code : 'HTTP_ERROR',
      http_status: err.status === 0 ? null : err.status,
      message: serverMessage ?? err.code,
      retryable: err.retryable,
      request_id: typeof err.requestId === 'string' ? (str(err.requestId, 100) ?? null) : null,
      what_to_do: adviceFor(err.code),
    };
    if (typeof err.retryAfterSeconds === 'number' && err.retryAfterSeconds >= 0) {
      out.retry_after_seconds = err.retryAfterSeconds;
      out.retry_at = new Date(ctx.nowMs + Math.ceil(err.retryAfterSeconds) * 1000).toISOString();
    }
    if (typeof err.field === 'string') out.field = str(err.field, 200) as string;
    // wrong rules words come back as SCHEMA_INVALID on word_answers: say what it really means
    if (err.code === 'SCHEMA_INVALID' && err.field === 'word_answers') out.what_to_do = adviceFor('WORDS_WRONG');
    for (const k of PASS_EXTRA) {
      const v = extra[k];
      if (typeof v === 'string') (out as Record<string, unknown>)[k] = str(v, 500);
      else if (typeof v === 'number' && Number.isFinite(v)) (out as Record<string, unknown>)[k] = v;
    }
    return out;
  }
  if (isNetworkError(err)) {
    return {
      status: 'error',
      code: 'NETWORK_ERROR',
      http_status: null,
      message: 'the service could not be reached',
      retryable: true,
      request_id: null,
      what_to_do: adviceFor('NETWORK_ERROR'),
    };
  }
  return {
    status: 'error',
    code: 'LOCAL_INTERNAL',
    http_status: null,
    message: 'internal error',
    retryable: false,
    request_id: null,
    what_to_do: adviceFor('LOCAL_INTERNAL'),
  };
}

/** fetch failures, aborts and socket errors: the request may or may not have reached the server. */
export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  if (err instanceof TypeError && /fetch failed|network/i.test(err.message)) return true;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR_[A-Z_]+)$/.test(code);
}

// Idempotency-Key rules (plan §1.6, rev 3). A key is stored in state.idem ONLY while a call has
// no final answer (network error, LOCAL_DEADLINE, 409 REQUEST_IN_PROGRESS). The same tool with
// the same canonical arguments then reuses it, so the server answers with the first result and
// nothing is done twice. A 5xx also counts as unresolved. The key is deleted as soon as any final
// status arrives (any 2xx, any other 4xx, 202 CHALLENGE_REQUIRED, VERIFICATION_PENDING). Step routes always get a fresh key.
import { createHash, randomUUID } from 'node:crypto';
import { AipeError, ChallengeRequired, ENDPOINTS, TransportRefused, VerificationPending } from 'aipe-sdk';
import { isNetworkError, LocalFailure } from './errors.ts';
import type { McpState } from './state.ts';

/** Routes whose repeats must give a new answer: never a stored key. */
export const STEP_ROUTES: ReadonlySet<string> = new Set(['startReasoning', 'preparePolicy', 'verifyProject', 'getSandboxCertificate']);

/** JSON with object keys sorted at every level (arrays keep their order). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function slotFor(tool: string, route: string, args: unknown): string {
  return `${tool}:${route}:${createHash('sha256').update(canonicalJson(args)).digest('hex').slice(0, 32)}`;
}

function isIdempotentRoute(route: string): boolean {
  const ep = (ENDPOINTS as Record<string, { idempotent?: boolean }>)[route];
  return ep?.idempotent === true;
}

export interface KeyPlan {
  slot: string;
  /** undefined: let the SDK make a fresh key (step routes) or none (non-idempotent routes) */
  key: string | undefined;
  reused: boolean;
}

/** The key to send for this call: a stored one if an earlier identical call got no final answer. */
export function planKey(state: McpState, tool: string, route: string, args: unknown, newKey: () => string = randomUUID): KeyPlan {
  const slot = slotFor(tool, route, args);
  if (STEP_ROUTES.has(route) || !isIdempotentRoute(route)) return { slot, key: undefined, reused: false };
  const stored = state.idem[slot];
  if (stored !== undefined) return { slot, key: stored.key, reused: true };
  return { slot, key: newKey(), reused: false };
}

export type Outcome = 'final' | 'unresolved';

/** Did this call get a final answer from the server? */
export function outcomeOf(result: { ok: true } | { ok: false; error: unknown }, deadlineHit: boolean): Outcome {
  if (result.ok) return 'final';
  const e = result.error;
  if (e instanceof ChallengeRequired || e instanceof VerificationPending) return 'final';
  if (e instanceof TransportRefused) return deadlineHit ? 'unresolved' : 'final';
  if (e instanceof AipeError) {
    if (e.code === 'REQUEST_IN_PROGRESS') return 'unresolved';
    // a 5xx (or an answer with no usable status) may have been applied: keep the key
    if (typeof e.status !== 'number' || !Number.isFinite(e.status) || e.status >= 500) return 'unresolved';
    return 'final';
  }
  if (e instanceof LocalFailure) return e.code === 'LOCAL_DEADLINE' ? 'unresolved' : 'final';
  return isNetworkError(e) ? 'unresolved' : 'final';
}

export interface IdemDeps {
  state: { update(change: (s: McpState) => void): Promise<McpState>; read(): Promise<McpState> };
  now: () => number;
  /** true when the current tool call's deadline refused an attempt */
  deadlineHit: () => boolean;
}

/**
 * Runs one API call under the rules above: plans the key from the stored state, runs `call`
 * with it, then stores or deletes the key depending on whether a final answer arrived.
 */
export async function runIdempotent<T>(
  deps: IdemDeps,
  tool: string,
  route: string,
  args: unknown,
  call: (idempotencyKey: string | undefined) => Promise<T>,
): Promise<T> {
  const plan = planKey(await deps.state.read(), tool, route, args);
  try {
    const out = await call(plan.key);
    await deps.state.update((s) => settleKey(s, plan, 'final', deps.now()));
    return out;
  } catch (error) {
    const outcome = outcomeOf({ ok: false, error }, deps.deadlineHit());
    await deps.state.update((s) => settleKey(s, plan, outcome, deps.now()));
    throw error;
  }
}

/** Applies the rule to the state: store the key while unresolved, delete it on a final answer. */
export function settleKey(state: McpState, plan: KeyPlan, outcome: Outcome, nowMs: number): void {
  if (plan.key === undefined) return;
  if (outcome === 'unresolved') state.idem[plan.slot] = { key: plan.key, at: nowMs };
  else delete state.idem[plan.slot];
}

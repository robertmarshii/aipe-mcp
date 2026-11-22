// Tool-call deadline and the wrapped SDK transport (plan §1.1, §1.6). Every tool call runs in a
// scope with a 45 s deadline for API work. The wrapped transport:
//   (a) adds `user-agent: aipe-mcp/<v> aipe-sdk/<v>` (not part of the signature; allowed);
//   (b) refuses to start a new attempt once the deadline has passed (TransportRefused, so the SDK
//       does not retry it), and shortens the per-attempt timeout to the time that is left.
// Human waits (elicitation) happen outside the API scope and do not use this budget.
import { AsyncLocalStorage } from 'node:async_hooks';
import { TransportRefused, type Transport } from 'aipe-sdk';

export const TOOL_DEADLINE_MS = 45_000;
export const ATTEMPT_TIMEOUT_MS = 15_000;

export interface CallScope {
  deadlineMs: number;
  deadlineHit: boolean;
  attempts: number;
}

const scopes = new AsyncLocalStorage<CallScope>();

export function currentScope(): CallScope | undefined {
  return scopes.getStore();
}

/** Runs fn with a fresh deadline (now + budget). The scope is returned for inspection. */
export async function withDeadline<T>(fn: (scope: CallScope) => Promise<T>, now: () => number = Date.now, budgetMs = TOOL_DEADLINE_MS): Promise<T> {
  const scope: CallScope = { deadlineMs: now() + budgetMs, deadlineHit: false, attempts: 0 };
  return scopes.run(scope, () => fn(scope));
}

/**
 * Runs fn outside any tool-call scope (a background task such as the practice run must not
 * inherit the 45 s deadline of the call that started it).
 */
export function outsideDeadline<T>(fn: () => T): T {
  return scopes.exit(fn);
}

export function wrapTransport(base: Transport, userAgent: string, now: () => number = Date.now): Transport {
  return async (req) => {
    const scope = scopes.getStore();
    let timeoutMs = req.timeoutMs;
    if (scope !== undefined) {
      const left = scope.deadlineMs - now();
      if (left <= 0) {
        scope.deadlineHit = true;
        throw new TransportRefused('LOCAL_DEADLINE');
      }
      timeoutMs = Math.min(timeoutMs, left);
      scope.attempts += 1;
    }
    return base({ ...req, timeoutMs, headers: { ...req.headers, 'user-agent': userAgent } });
  };
}

// Helpers shared by the tool implementations: the current key, the agent id, idempotent calls,
// remembered retry_at per route, and the switch to a recovered key.
import { rename, rm, chmod } from 'node:fs/promises';
import { AipeError, type AipeClient } from 'aipe-sdk';
import { LocalFailure } from '../runtime/errors.ts';
import { rememberRetry, retryBlockedUntil } from '../runtime/guards.ts';
import { runIdempotent } from '../runtime/idempotency.ts';
import { exists, loadKeyChecked } from '../runtime/keystore.ts';
import type { CurrentKey, Runtime } from '../runtime/runtime.ts';
import type { McpState } from '../runtime/state.ts';
import type { ToolContext } from './pipeline.ts';

/**
 * The server does not accept this key at all (unknown, wrong signature for it, or revoked).
 * Other 401s (an expired signature from clock skew, a reused nonce) say nothing about the key.
 */
export function keyNotAccepted(err: unknown): boolean {
  return err instanceof AipeError && err.status === 401 && ['UNKNOWN_KEY', 'SIGNATURE_INVALID', 'KEY_REVOKED'].includes(err.code);
}

/** Server waits up to this long are retried by the SDK; longer ones are remembered per route. */
export const SDK_MAX_WAIT_S = 20;

export async function needKey(rt: Runtime): Promise<CurrentKey> {
  const k = await rt.keys.current();
  if (k === null) throw new LocalFailure('LOCAL_NO_KEY', 'no agent key in this profile yet');
  return k;
}

/** The agent id from state, or from GET /agents/me (then saved). */
export async function agentId(ctx: ToolContext, client: AipeClient): Promise<string> {
  const s = await ctx.rt.state.read();
  if (typeof s.agent_id === 'string') return s.agent_id;
  const me = await client.getMe();
  await ctx.rt.state.update((x) => {
    x.agent_id = me.agent_id;
    x.agent_name = me.name;
  });
  return me.agent_id;
}

/** Runs one API call under the idempotency rules (stored key only while unresolved). */
export function idem<T>(ctx: ToolContext, route: string, args: unknown, call: (key: string | undefined) => Promise<T>): Promise<T> {
  return runIdempotent({ state: ctx.rt.state, now: ctx.rt.now, deadlineHit: () => ctx.scope.deadlineHit }, ctx.spec.name, route, args, call);
}

/** Refuses locally while a remembered retry_at for the route is in the future. */
export async function checkRetry(ctx: ToolContext, route: string): Promise<void> {
  const until = retryBlockedUntil(await ctx.rt.state.read(), route, ctx.rt.now());
  if (until !== null) {
    throw new LocalFailure('LOCAL_RETRY_LATER', 'this action is paused until retry_at', { extra: { retry_at: new Date(until).toISOString() } });
  }
}

/** Remembers a long server wait (beyond what the SDK retries) for the route. */
export async function noteRetry(ctx: ToolContext, route: string, err: unknown): Promise<void> {
  if (err instanceof AipeError && typeof err.retryAfterSeconds === 'number' && err.retryAfterSeconds > SDK_MAX_WAIT_S) {
    const at = ctx.rt.now() + Math.ceil(err.retryAfterSeconds) * 1000;
    await ctx.rt.state.update((s) => rememberRetry(s, route, at));
  }
}

/** Wraps a route call: local retry_at check before, remembered retry_at after a long wait. */
export async function guarded<T>(ctx: ToolContext, route: string, call: () => Promise<T>): Promise<T> {
  await checkRetry(ctx, route);
  try {
    return await call();
  } catch (err) {
    await noteRetry(ctx, route, err);
    throw err;
  }
}

/**
 * Key switch after a recovery (plan §2.2 aipe_key_recover): when key.next.pem exists and
 * authenticates (GET /agents/me answers 200), key.pem becomes key.old.pem and key.next.pem
 * becomes key.pem (0600). Runs at server start and before non-read-only tools, never in
 * aipe_status. Returns true when it switched.
 */
export async function maybeSwitchKey(rt: Runtime): Promise<boolean> {
  const cfg = rt.cfg;
  if (cfg.explicitKeyFile !== undefined) return false; // a mounted key is never renamed
  if (!(await exists(cfg.nextKeyFile))) return false;
  let next: Uint8Array;
  try {
    next = await loadKeyChecked(cfg.nextKeyFile, rt.keys.options);
  } catch {
    return false;
  }
  try {
    // one attempt, short timeout: this must never hold up the server (start, or a tool call)
    await rt.probeClient(next).getMe();
  } catch {
    return false; // not yet: the recovery has not completed, or the service is unreachable
  }
  if (await exists(cfg.keyFile)) {
    await rm(cfg.oldKeyFile, { force: true });
    await rename(cfg.keyFile, cfg.oldKeyFile);
    await chmod(cfg.oldKeyFile, 0o600);
  }
  await rename(cfg.nextKeyFile, cfg.keyFile);
  await chmod(cfg.keyFile, 0o600);
  await rt.keys.refresh();
  await rt.state.update((s: McpState) => {
    s.recovery = null;
  });
  rt.log('info', 'KEY_SWITCHED');
  return true;
}

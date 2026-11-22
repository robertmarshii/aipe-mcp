// The common path of every tool call:
//   1. outgoing leak preflight on the tool's free-text fields (nothing sent on a refusal);
//   2. the confirmation gate (elicitation, token path or the H rules);
//   3. the tool's own work inside the 45 s deadline scope;
//   4. any thrown error normalised, then the status object turned into a CallToolResult.
import type { ToolSpec } from '../contract/tools.ts';
import { confirmGate, confirmPossibleSecret, type ElicitPort } from '../runtime/confirm.ts';
import { withDeadline, type CallScope } from '../runtime/deadline.ts';
import { LocalFailure, normaliseError } from '../runtime/errors.ts';
import { preflight, textFields } from '../runtime/preflight.ts';
import { toToolResult, type StatusObject, type ToolResult } from '../runtime/result.ts';
import { maybeSwitchKey } from './common.ts';
import type { Runtime } from '../runtime/runtime.ts';

export interface ToolContext {
  rt: Runtime;
  spec: ToolSpec;
  port: ElicitPort;
  scope: CallScope;
  /** progress notifications, when the client sent a progressToken */
  progress(done: number, total?: number): Promise<void>;
}

export type Executor = (args: Record<string, unknown>, ctx: ToolContext) => Promise<StatusObject>;

/** The plain-language confirmation summary of a call (static text plus capped ids only). */
export type Summariser = (args: Record<string, unknown>) => string;

export interface ToolImpl {
  execute: Executor;
  summary?: Summariser;
}

export interface CallInput {
  rt: Runtime;
  spec: ToolSpec;
  impl: ToolImpl;
  args: Record<string, unknown>;
  port: ElicitPort;
  progress: (done: number, total?: number) => Promise<void>;
}

export type CallOutput = ToolResult | { defer: unknown };

/** DEC26: an owner-opt-in tool (aipe_offer_accept) is H only under AIPE_CONFIRM_ACCEPT=owner. */
export function confirmSpecOf(spec: ToolSpec, confirmAccept: 'agent' | 'owner'): ToolSpec {
  return spec.ownerOptIn === true && confirmAccept === 'owner' ? { ...spec, confirm: 'standard', human: true } : spec;
}

export async function runTool(c: CallInput): Promise<CallOutput> {
  const { rt, spec } = c;
  const { confirm_token: confirmToken, ...args } = c.args as Record<string, unknown> & { confirm_token?: unknown };
  try {
    // 1. preflight
    const pf = preflight(textFields(args, spec.preflight), rt.keys.seeds());
    if (pf.kind === 'refuse') {
      return toToolResult(normaliseError(localSecret(pf.field), { nowMs: rt.now() }));
    }
    if (pf.kind === 'possible_secret') {
      const value = textFields(args, spec.preflight).find((f) => f.name === pf.field)?.value ?? '';
      const d = await confirmPossibleSecret(c.port, pf.field, value, rt.cfg.confirmVia);
      if (!d.proceed) return 'defer' in d ? { defer: d.defer } : toToolResult(d.result as unknown as StatusObject);
    }
    // 2. confirmation
    const gate = await confirmGate({
      spec: confirmSpecOf(spec, rt.cfg.confirmAccept),
      level: rt.cfg.confirm,
      via: rt.cfg.confirmVia,
      env: rt.cfg.env,
      args,
      confirmToken: typeof confirmToken === 'string' ? confirmToken : undefined,
      summary: c.impl.summary?.(args) ?? `${spec.title}.`,
      port: c.port,
      tokens: rt.tokens,
    });
    if (!gate.proceed) return 'defer' in gate ? { defer: gate.defer } : toToolResult(gate.result as unknown as StatusObject);
    // 3. a recovered key takes over before any non-read-only tool (never in aipe_status)
    if (!spec.readOnly) await maybeSwitchKey(rt).catch(() => false);
    // 4. the work, inside the deadline scope
    let scopeRef: CallScope | undefined;
    try {
      const out = await withDeadline(
        (scope) => {
          scopeRef = scope;
          return c.impl.execute(args, { rt, spec, port: c.port, scope, progress: c.progress });
        },
        rt.now,
      );
      return toToolResult(out);
    } catch (err) {
      rt.log('warn', 'TOOL_ERROR', { tool: spec.name });
      return toToolResult(normaliseError(err, { nowMs: rt.now(), deadlineHit: scopeRef?.deadlineHit === true }));
    }
  } catch (err) {
    rt.log('warn', 'TOOL_ERROR', { tool: spec.name });
    return toToolResult(normaliseError(err, { nowMs: rt.now() }));
  }
}

function localSecret(field: string): LocalFailure {
  return new LocalFailure('LOCAL_SECRET_IN_TEXT', `the field ${field} contains private key material; nothing was sent`);
}

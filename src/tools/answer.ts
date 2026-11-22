// aipe_answer (plan §2.2): one answer tool for every challenge or question this server handed
// out. The id is looked up in our own pending table (it records the kind of each); the answer is
// checked locally against answer_schema first, so a malformed answer uses no attempt.
import { Ajv2020 } from 'ajv/dist/2020.js';
import { forgetPending, pendingKind } from '../runtime/challenges.ts';
import { LocalFailure } from '../runtime/errors.ts';
import type { StatusObject } from '../runtime/result.ts';
import { sanitiseDeep } from '../runtime/sanitise.ts';
import { agentId, guarded, idem, needKey } from './common.ts';
import type { ToolImpl } from './pipeline.ts';
import { answerSandbox } from './sandbox.ts';

const ajv = new Ajv2020({ strict: false, allErrors: false, validateSchema: false });

/** Checks an answer against the challenge's answer_schema; throws LOCAL_ANSWER_SCHEMA. */
export function checkAnswer(schema: Record<string, unknown> | null | undefined, answer: unknown): void {
  if (schema === null || schema === undefined || Object.keys(schema).length === 0) return;
  let ok: boolean;
  try {
    ok = ajv.validate(schema, answer) === true;
  } catch {
    return; // a schema we cannot compile is checked by the server alone
  }
  if (!ok) {
    const where = ajv.errors?.[0]?.instancePath ?? '';
    throw new LocalFailure('LOCAL_ANSWER_SCHEMA', `the answer does not match answer_schema${where === '' ? '' : ` at ${where}`}; no attempt was used`);
  }
}

const REASONING_NEXT: Readonly<Record<string, string>> = {
  passed: 'Correct. Call aipe_reasoning_start for the next challenge.',
  incorrect: 'Not correct. Read the prompt again and answer once more with aipe_answer before it expires.',
  failed: 'Failed: onboarding is locked for now. Check aipe_status for when it unlocks.',
};

export const answerTool: ToolImpl = {
  async execute(args, ctx): Promise<StatusObject> {
    const id = String(args.id);
    const pending = pendingKind(await ctx.rt.state.read(), id);
    if (pending === undefined) throw new LocalFailure('LOCAL_UNKNOWN_ANSWER_ID', 'that id is not waiting for an answer');
    if (pending.kind === 'sandbox') return answerSandbox(id, args, ctx);
    const answer = args.answer ?? {};
    checkAnswer(pending.answer_schema, answer);
    const key = await needKey(ctx.rt);
    const client = ctx.rt.mainClient(key.seed);
    if (pending.kind === 'reasoning') {
      const agent = await agentId(ctx, client);
      const body = { challenge_id: id, answer };
      const r = await guarded(ctx, 'answerReasoning', () =>
        idem(ctx, 'answerReasoning', body, (k) => client.answerReasoning({ id: agent }, body, k === undefined ? undefined : { idempotencyKey: k })),
      );
      if (r.result !== 'incorrect') await ctx.rt.state.update((s) => forgetPending(s, id));
      ctx.rt.polls.clear('challenge_answer');
      const result = {
        result: r.result,
        ...(r.passed === undefined ? {} : { passed: r.passed }),
        ...(r.of === undefined ? {} : { of: r.of }),
        ...(r.attempts_left === undefined ? {} : { attempts_left: r.attempts_left }),
        ...(typeof r.retry_after_seconds === 'number' ? { retry_at: new Date(ctx.rt.now() + r.retry_after_seconds * 1000).toISOString() } : {}),
      };
      const next = r.status === 'passed' ? 'All reasoning challenges are passed. Next: aipe_rules_prepare.' : (REASONING_NEXT[r.result] ?? 'Call aipe_status.');
      return { status: 'ok', kind: 'reasoning', result, next };
    }
    // a guard challenge: answering runs the stored operation
    const r = await client.answerChallenge({ id }, { answer });
    await ctx.rt.state.update((s) => forgetPending(s, id));
    ctx.rt.polls.clear('challenge_answer');
    return { status: 'ok', kind: 'gate_challenge', result: sanitiseDeep(r).value, next: 'Answered. The stored request has run; check its result above. Do not resend it.' };
  },
};

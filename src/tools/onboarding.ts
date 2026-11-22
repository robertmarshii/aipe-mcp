// Onboarding tools (plan §2.2): register, reasoning start, rules prepare and accept, the security
// self-assessment and activation. Static `next` texts only; ids and timestamps from our own state.
import { canonicalPolicyText, type AipeClient } from 'aipe-sdk';
import { rememberPending } from '../runtime/challenges.ts';
import { LocalFailure } from '../runtime/errors.ts';
import { ensureProfileDir, createKey } from '../runtime/keystore.ts';
import type { StatusObject } from '../runtime/result.ts';
import { sanitiseString } from '../runtime/sanitise.ts';
import { outcomeOf } from '../runtime/idempotency.ts';
import { numberedWords } from '../runtime/words.ts';
import { agentId, guarded, idem, needKey } from './common.ts';
import type { ToolContext, ToolImpl } from './pipeline.ts';

function secondsLeft(iso: string | undefined | null, nowMs: number): number | undefined {
  if (typeof iso !== 'string') return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((t - nowMs) / 1000)) : undefined;
}

/** The profile key, created (0700 folder, 0600 file) when there is none yet. */
export async function keyOrCreate(ctx: ToolContext): Promise<{ seed: Uint8Array; keyid: string }> {
  const existing = await ctx.rt.keys.current();
  if (existing !== null) return existing;
  const o = ctx.rt.keys.options;
  await ensureProfileDir(ctx.rt.cfg.profileDir, o);
  const k = await createKey(ctx.rt.cfg.keyFile, o);
  ctx.rt.keys.add(k.seed);
  return k;
}

// ------------------------------------------------------------------ aipe_register

export const registerTool: ToolImpl = {
  summary: (a) =>
    `Register this agent under the public name ${JSON.stringify(sanitiseString(String(a.agent_name), 64).text)}. Registration is limited per network address, so this is normally a one-time step.`,
  async execute(args, ctx): Promise<StatusObject> {
    const name = String(args.agent_name);
    const key = await keyOrCreate(ctx);
    const client = ctx.rt.mainClient(key.seed);
    const s = await ctx.rt.state.read();
    if (typeof s.agent_id === 'string') {
      return { status: 'ok', agent_id: s.agent_id, keyid: key.keyid, state: 'REGISTERED', next: 'Already registered. Next: aipe_reasoning_start.' };
    }
    let reg = s.registration ?? null;
    if (reg !== null && Date.parse(reg.expires_at) <= ctx.rt.now()) reg = null;
    if (reg === null) {
      const r = await guarded(ctx, 'register', () => client.register({ agentName: name }));
      reg = { registration_id: r.registration_id, nonce: r.nonce, expires_at: r.expires_at };
      const saved = reg;
      await ctx.rt.state.update((x) => {
        x.registration = saved;
        x.agent_name = name;
      });
    }
    const proved = await client.proveKey(reg);
    await ctx.rt.state.update((x) => {
      x.registration = null;
      x.agent_id = proved.agent_id;
      x.agent_name = x.agent_name ?? name;
    });
    return {
      status: 'ok',
      agent_id: proved.agent_id,
      keyid: key.keyid,
      state: proved.state,
      next: 'Registered. Next: aipe_reasoning_start, then answer each challenge with aipe_answer.',
    };
  },
};

// ------------------------------------------------------------------ aipe_reasoning_start

export const reasoningStartTool: ToolImpl = {
  async execute(_args, ctx): Promise<StatusObject> {
    const key = await needKey(ctx.rt);
    const client = ctx.rt.mainClient(key.seed);
    const id = await agentId(ctx, client);
    // a step route: always a fresh Idempotency-Key (the SDK makes one)
    const r = await guarded(ctx, 'startReasoning', () => client.startReasoning({ id }, {}));
    if (r.status === 'passed' || r.challenge_id === undefined) {
      return { status: 'ok', passed: true, next: 'All reasoning challenges are passed. Next: aipe_rules_prepare.' };
    }
    const nowMs = ctx.rt.now();
    const left = secondsLeft(r.expires_at, nowMs);
    await ctx.rt.state.update((s) =>
      rememberPending(s, r.challenge_id as string, { kind: 'reasoning', tool: 'aipe_reasoning_start', expires_at: r.expires_at ?? null, answer_schema: r.answer_schema ?? null }, nowMs),
    );
    return {
      status: 'ok',
      challenge_id: r.challenge_id,
      ...(r.index === undefined ? {} : { index: r.index }),
      ...(r.of === undefined ? {} : { of: r.of }),
      prompt: sanitiseString(r.prompt ?? '', 8000).text,
      answer_schema: r.answer_schema ?? {},
      ...(r.expires_at === undefined ? {} : { expires_at: r.expires_at }),
      ...(left === undefined ? {} : { seconds_left: left }),
      next: `Answer now with aipe_answer (id ${r.challenge_id}), in exactly the form the last paragraph of the prompt asks for. You have 2 attempts.`,
    };
  },
};

// ------------------------------------------------------------------ aipe_rules_prepare

export const rulesPrepareTool: ToolImpl = {
  async execute(args, ctx): Promise<StatusObject> {
    const key = await needKey(ctx.rt);
    const client = ctx.rt.mainClient(key.seed);
    const id = await agentId(ctx, client);
    const onboarding = await client.getOnboarding();
    const left = onboarding.steps.rules.challenges_left;
    if (left === 0 && args.confirm_lock_risk !== true) {
      throw new LocalFailure('LOCAL_LOCK_RISK', 'no rules attempts are left: preparing again locks the rules step', { extra: { challenges_left: 0 } });
    }
    const policy = await client.getPolicy();
    const prepared = await guarded(ctx, 'preparePolicy', () => client.preparePolicy({ id }, {}));
    client.verifyPolicy(prepared as never, policy.hash);
    const saved = client.sandboxState();
    await ctx.rt.state.update((s) => {
      s.live_prepared = saved;
    });
    const nowMs = ctx.rt.now();
    return {
      status: 'ok',
      policy_version: prepared.policy_version,
      policy_hash: prepared.policy_hash,
      verified: true,
      challenges_left: left,
      rules_text: canonicalPolicyText(prepared.rules as never),
      questions: prepared.positions.map((position, i) => ({ rule: i + 1, position })),
      numbered_words: numberedWords(prepared.rules),
      expires_at: prepared.expires_at,
      seconds_left: secondsLeft(prepared.expires_at, nowMs) ?? 0,
      next: 'Read the full rules text first. Then call aipe_rules_accept with the rule numbers you accept and, for each question, the word at that position of that rule. You have 10 minutes and one accept attempt.',
    };
  },
};

// ------------------------------------------------------------------ aipe_rules_accept

export const rulesAcceptTool: ToolImpl = {
  summary: () => 'Accept the platform rules as prepared.',
  async execute(args, ctx): Promise<StatusObject> {
    const key = await needKey(ctx.rt);
    const client = ctx.rt.mainClient(key.seed);
    const s = await ctx.rt.state.read();
    if (s.live_prepared === undefined || s.live_prepared === null) {
      throw new LocalFailure('LOCAL_NOT_PREPARED', 'call aipe_rules_prepare first');
    }
    const prep = (s.live_prepared as { prepared?: { policy?: { expires_at?: string } } | null }).prepared;
    const expires = prep?.policy?.expires_at;
    const clear = () =>
      ctx.rt.state.update((x) => {
        x.live_prepared = null;
      });
    if (typeof expires !== 'string' || Date.parse(expires) <= ctx.rt.now()) {
      await clear();
      throw new LocalFailure('LOCAL_NOT_PREPARED', 'the prepared rules expired: call aipe_rules_prepare again');
    }
    client.restoreSandboxState(s.live_prepared as never);
    const name = s.agent_name ?? (await client.getMe()).name;
    let out;
    try {
      out = await client.acceptPolicy({
        acceptedRules: args.accepted_rules as number[],
        wordAnswers: args.word_answers as Record<string, string>,
        agentName: name,
      });
    } catch (err) {
      // a final answer (wrong words, expired, schema) uses up this prepared challenge
      if (outcomeOf({ ok: false, error: err }, ctx.scope.deadlineHit) === 'final') await clear();
      throw err;
    }
    await clear();
    return { status: 'ok', accepted: out.accepted, policy_hash: out.policy_hash, next: 'Rules accepted. Next: aipe_project_create.' };
  },
};

// ------------------------------------------------------------------ aipe_security_assessment

export const securityAssessmentTool: ToolImpl = {
  async execute(args, ctx): Promise<StatusObject> {
    const key = await needKey(ctx.rt);
    const client = ctx.rt.mainClient(key.seed);
    const id = await agentId(ctx, client);
    const body = {
      tools_with_external_access: args.tools_with_external_access as string[],
      handles_untrusted_input: args.handles_untrusted_input as boolean,
      human_approval_for_actions: args.human_approval_for_actions as 'always' | 'sometimes' | 'never',
      can_post_publicly: args.can_post_publicly as boolean,
      stores_credentials: args.stores_credentials as boolean,
      ...(typeof args.notes === 'string' ? { notes: args.notes } : {}),
    };
    const r = await idem(ctx, 'submitSecurityAssessment', body, (k) => client.submitSecurityAssessment({ id }, body, k === undefined ? undefined : { idempotencyKey: k }));
    return { status: 'ok', submitted: r.submitted };
  },
};

// ------------------------------------------------------------------ aipe_activate

function certificateOf(s: { certificate?: { value: string; expires_at: string } | null }, nowMs: number): string {
  const c = s.certificate;
  if (c === undefined || c === null || Date.parse(c.expires_at) <= nowMs) {
    throw new LocalFailure('NOT_CERTIFIED', 'no valid practice certificate: run aipe_sandbox_certify first');
  }
  return c.value;
}

export const activateTool: ToolImpl = {
  summary: () => 'Activate this agent on the exchange.',
  async execute(_args, ctx): Promise<StatusObject> {
    const key = await needKey(ctx.rt);
    const client: AipeClient = ctx.rt.mainClient(key.seed);
    const id = await agentId(ctx, client);
    const certificate = certificateOf(await ctx.rt.state.read(), ctx.rt.now());
    const body = { certificate };
    const r = await idem(ctx, 'activate', { id }, (k) => client.activate({ id }, body, k === undefined ? undefined : { idempotencyKey: k }));
    const next =
      ctx.rt.cfg.toolset === 'onboarding'
        ? 'The agent is active. Ask your owner to switch AIPE_TOOLSET to trading for the trading tools.'
        : 'The agent is active. Use the trading tools: aipe_search, aipe_listing_create, aipe_notifications.';
    return { status: 'ok', state: r.state === 'ACTIVE' ? 'ACTIVE' : r.state, next };
  },
};


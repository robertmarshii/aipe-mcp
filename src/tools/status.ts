// aipe_status (plan §2.2): where the agent stands and the next step. Read-only: it never writes
// state, never creates folders and never renames key files. With no key it answers from local
// facts only, with no network call.
import { AipeError, describeProof, type AipeClient } from 'aipe-sdk';
import { ONBOARDING_NEXT } from '../content/advice.ts';
import { challengeShape } from '../runtime/challenges.ts';
import type { StatusObject } from '../runtime/result.ts';
import { sanitiseString } from '../runtime/sanitise.ts';
import type { McpState } from '../runtime/state.ts';
import { keyNotAccepted } from './common.ts';
import type { ToolContext, ToolImpl } from './pipeline.ts';

const NEXT_FOR_STEP = ONBOARDING_NEXT;

/** Some routes are only for active agents and answer NOT_CERTIFIED during onboarding. */
async function unlessNotCertified<T>(call: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof AipeError && err.code === 'NOT_CERTIFIED') return fallback;
    throw err;
  }
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? sanitiseString(v, max).text : null);
const texts = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 20).map((x) => sanitiseString(x, max).text) : []);

/** The agent's own project as written (trade test 22 Nov: the agent could not see it). */
export function projectDetails(p: Record<string, unknown>): Record<string, unknown> {
  return {
    name: text(p.name, 120),
    summary: text(p.summary, 500),
    audience: text(p.audience, 1000),
    goals: text(p.goals, 1000),
    keywords: texts(p.keywords, 64),
    example_urls: texts(p.example_urls, 2048),
  };
}

/** A plain ISO-8601 UTC timestamp, or null. */
export function isoTime(v: unknown): string | null {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v) ? v : null;
}


function certificateView(s: McpState, nowMs: number): { present: boolean; expires_at: string | null } {
  const c = s.certificate;
  if (c === undefined || c === null) return { present: false, expires_at: null };
  return { present: Date.parse(c.expires_at) > nowMs, expires_at: c.expires_at };
}

function nextWithoutAgent(s: McpState, nowMs: number): string {
  if (s.registration !== undefined && s.registration !== null) return 'A registration is pending: call aipe_register again to finish it.';
  if (certificateView(s, nowMs).present) return 'Next: aipe_register (ask your owner first: the name is public).';
  return 'Start with aipe_sandbox_certify: it creates the key and earns the practice certificate.';
}

async function onlineStatus(client: AipeClient, s: McpState, nowMs: number): Promise<StatusObject> {
  const me = await client.getMe();
  const onboarding = me.state === 'ACTIVE' ? null : await client.getOnboarding();
  // live run 22 Nov: right after register these answered NOT_CERTIFIED ("run aipe_sandbox_certify");
  // gate challenges and listings only exist for an agent past onboarding
  const onboardingNow = me.state === 'ONBOARDING';
  const noChallenge = { challenge: null } as unknown as Awaited<ReturnType<AipeClient['getPendingChallenge']>>;
  const noListings = { items: [] } as unknown as Awaited<ReturnType<AipeClient['listMyListings']>>;
  const pending = onboardingNow ? noChallenge : await unlessNotCertified(() => client.getPendingChallenge(), noChallenge);
  let project: Record<string, unknown> | null = null;
  const projectId = me.project.project_id;
  if (projectId !== null) {
    const p = (await client.getProject({ id: projectId })).project;
    project = { id: p.id, kind: p.kind, identity: p.identity, status: p.status, check: p.check, ...projectDetails(p as unknown as Record<string, unknown>) };
    if (p.status === 'PENDING') {
      const proof = describeProof(p as never) as unknown as Record<string, unknown>;
      project.proof_code = p.proof.code;
      project.owner_action = {
        ...proof,
        note: 'Only your human owner can publish this; do not do it with other tools unless they explicitly tell you to.',
      };
    }
  }
  const mine = onboardingNow ? noListings : await unlessNotCertified(() => client.listMyListings(undefined, undefined, { query: { limit: 20 } }), noListings);
  const steps = onboarding?.steps;
  let next = me.state === 'ACTIVE' ? 'The agent is active. Use the trading tools: aipe_search, aipe_notifications, aipe_listing_create.' : (NEXT_FOR_STEP[onboarding?.next_step ?? ''] ?? 'Call aipe_status again later.');
  if (steps !== undefined) {
    // `next` is static text plus timestamps and counts only: a server value that is not a plain
    // timestamp or integer is left out, never copied in
    const rulesLock = isoTime(steps.rules.locked_until);
    const reasoningLock = isoTime(steps.reasoning.locked_until);
    const left = steps.rules.challenges_left;
    if (rulesLock !== null) next += ` The rules step is locked until ${rulesLock}.`;
    if (reasoningLock !== null) next += ` Reasoning is locked until ${reasoningLock}.`;
    if (Number.isSafeInteger(left)) next += ` Rules attempts left: ${left}.`;
  }
  return {
    status: 'ok',
    environment: client.environment,
    key: { present: true, keyid: client.keyid },
    agent: { agent_id: me.agent_id, name: me.name, state: me.state, created_at: me.created_at },
    onboarding: onboarding === null ? null : { state: onboarding.state, steps: onboarding.steps, next_step: onboarding.next_step },
    certificate: certificateView(s, nowMs),
    project,
    my_listings: mine.items.map((l) => ({ id: l.id, status: l.status, filled_slots: l.filled_slots, expires_at: l.expires_at, untrusted: l.untrusted_content.fields })),
    pending_challenge: pending.challenge === null ? null : challengeShape(pending.challenge, nowMs),
    recovery: me.recovery,
    next,
  };
}

export const statusTool: ToolImpl = {
  async execute(_args, ctx: ToolContext): Promise<StatusObject> {
    const { rt } = ctx;
    const nowMs = rt.now();
    const key = await rt.keys.current();
    const s = await rt.state.read();
    const offline = {
      status: 'ok',
      environment: rt.cfg.env,
      key: { present: key !== null, keyid: key?.keyid ?? null },
      agent: null,
      onboarding: null,
      certificate: certificateView(s, nowMs),
      project: null,
      my_listings: [],
      pending_challenge: null,
      recovery: null,
      next: nextWithoutAgent(s, nowMs),
    } satisfies StatusObject;
    if (key === null) return offline;
    // The practice sandbox is not a real agent account: its routes need the run's step token and
    // answer 400 before their scenario step (found in B1). Status stays local there.
    if (rt.cfg.env === 'sandbox') {
      const inRun = !certificateView(s, nowMs).present && s.sandbox !== undefined && s.sandbox !== null;
      return inRun ? { ...offline, next: 'A practice run is in progress: call aipe_sandbox_certify to continue, and answer its questions with aipe_answer.' } : offline;
    }
    try {
      return await onlineStatus(rt.mainClient(key.seed), s, nowMs);
    } catch (err) {
      if (keyNotAccepted(err)) return offline;
      throw err;
    }
  },
};

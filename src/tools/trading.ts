// Trading tools (plan §2.2, M5): listings, search and keyword suggestions, offers (review gate),
// commitments and exchanges, reviews (support offers dropped), notifications (static mapping) and
// listing reports (provenance guard). Third-party text goes under `untrusted` only.
import { ChallengeRequired, type AipeClient } from 'aipe-sdk';
import { fromChallengePending, fromChallengeRequired, rememberPending } from '../runtime/challenges.ts';
import { LocalFailure } from '../runtime/errors.ts';
import { provenanceOk, recordSeen, reviewGate, type ClearEvent, type PollRoute } from '../runtime/guards.ts';
import { canonicalJson } from '../runtime/idempotency.ts';
import type { StatusObject } from '../runtime/result.ts';
import { sanitiseString } from '../runtime/sanitise.ts';
import { guarded, idem, needKey } from './common.ts';
import type { ToolContext, ToolImpl } from './pipeline.ts';

const POLL_MS = 60_000;
const q = (s: unknown, max = 120) => JSON.stringify(sanitiseString(String(s), max).text);
const opt = (k: string | undefined) => (k === undefined ? undefined : { idempotencyKey: k });

async function client(ctx: ToolContext): Promise<AipeClient> {
  return ctx.rt.mainClient((await needKey(ctx.rt)).seed);
}

type Fields = { fields?: Record<string, unknown> } | null | undefined;
const fieldsOf = (u: Fields) => (u === null || u === undefined ? null : (u.fields ?? {}));

function listingView(l: Record<string, unknown>): Record<string, unknown> {
  return {
    id: l.id,
    ...(l.status === undefined ? {} : { status: l.status }),
    ...(l.expires_at === undefined ? {} : { expires_at: l.expires_at }),
    ...(l.filled_slots === undefined ? {} : { filled_slots: l.filled_slots }),
    ...(l.project === undefined ? {} : { project: l.project }),
    untrusted: fieldsOf(l.untrusted_content as Fields),
  };
}

/** A gate challenge (202) or an open earlier one (409) as a tool result; anything else rethrows. */
async function challengeResult(ctx: ToolContext, err: unknown): Promise<StatusObject> {
  const nowMs = ctx.rt.now();
  if (err instanceof ChallengeRequired) {
    const r = fromChallengeRequired(err, nowMs);
    await ctx.rt.state.update((s) => rememberPending(s, r.challenge.id, { kind: 'gate_challenge', tool: ctx.spec.name, expires_at: r.challenge.expires_at ?? null, answer_schema: r.challenge.answer_schema }, nowMs));
    return r as unknown as StatusObject;
  }
  const p = fromChallengePending(err, nowMs);
  if (p !== null) {
    await ctx.rt.state.update((s) => rememberPending(s, p.challenge.id, { kind: 'gate_challenge', tool: ctx.spec.name, expires_at: p.challenge.expires_at ?? null, answer_schema: p.challenge.answer_schema }, nowMs));
    return p as unknown as StatusObject;
  }
  throw err;
}

/** Poll guard: a repeat within a minute answers `cached` with the earlier data. */
async function polled(ctx: ToolContext, route: PollRoute, args: unknown, fetch: () => Promise<StatusObject>): Promise<StatusObject> {
  const key = ctx.rt.polls.key(route, args);
  const nowMs = ctx.rt.now();
  const hit = ctx.rt.polls.cache.get(key, nowMs);
  if (hit !== undefined) {
    const data = hit.value as StatusObject;
    return { ...data, status: 'cached', cached_at: new Date(hit.at).toISOString(), next_poll_after: new Date(hit.at + POLL_MS).toISOString(), next: 'Checked less than a minute ago: this is the earlier result. Try again after next_poll_after.' };
  }
  const out = await fetch();
  ctx.rt.polls.remember(key, out, nowMs);
  return out;
}

const clear = (ctx: ToolContext, e: ClearEvent) => ctx.rt.polls.clear(e);

// ------------------------------------------------------------------ listings

export const listingCreateTool: ToolImpl = {
  summary: (a) => `Publish a public listing titled ${q(a.title)} asking for promotion of ${q((a.target_urls as string[] | undefined)?.join(', ') ?? '', 200)}.`,
  async execute(args, ctx) {
    const c = await client(ctx);
    const body = { title: args.title, summary: args.summary, request: args.request, target_urls: args.target_urls, keywords: args.keywords, language: args.language } as never;
    try {
      const l = await guarded(ctx, 'createListing', () => idem(ctx, 'createListing', body, (k) => c.createListing(undefined, body, opt(k))));
      return { status: 'ok', listing: listingView(l as never) };
    } catch (err) {
      return challengeResult(ctx, err);
    }
  },
};

export const listingGetTool: ToolImpl = {
  async execute(args, ctx) {
    const c = await client(ctx);
    const id = String(args.listing_id);
    const l = (await guarded(ctx, 'getListing', () => c.getListing({ id }))) as unknown as Record<string, unknown>;
    const fields = fieldsOf(l.untrusted_content as Fields);
    await ctx.rt.state.update((s) => recordSeen(s, String(l.id), 'detail', ctx.rt.now(), fields));
    return { status: 'ok', listing: listingView(l) };
  },
};

export const listingEndTool: ToolImpl = {
  summary: (a) => `${a.action === 'close' ? 'Close' : 'Withdraw'} your listing ${String(a.listing_id)}.`,
  async execute(args, ctx) {
    const c = await client(ctx);
    const id = String(args.listing_id);
    const route = args.action === 'close' ? 'closeListing' : 'withdrawListing';
    const l = await idem(ctx, route, { id }, (k) => (route === 'closeListing' ? c.closeListing({ id }, undefined, opt(k)) : c.withdrawListing({ id }, undefined, opt(k))));
    return { status: 'ok', listing: listingView(l as never) };
  },
};

// ------------------------------------------------------------------ search

export const searchTool: ToolImpl = {
  async execute(args, ctx) {
    const given = ['keywords', 'cursor', 'suggest_for'].filter((k) => args[k] !== undefined);
    if (given.length !== 1) throw new LocalFailure('SCHEMA_INVALID', 'pass exactly one of keywords, cursor or suggest_for', { extra: { field: 'keywords' } });
    const c = await client(ctx);
    const key = canonicalJson(args);
    const nowMs = ctx.rt.now();
    const hit = ctx.rt.searches.get(key, nowMs);
    if (hit !== undefined) {
      return { ...(hit.value as StatusObject), status: 'cached', cached_at: new Date(hit.at).toISOString(), next_poll_after: new Date(hit.at + POLL_MS).toISOString(), next: 'The same search ran less than a minute ago: this is the earlier result.' };
    }
    let out: StatusObject;
    if (typeof args.suggest_for === 'string') {
      const r = await guarded(ctx, 'suggestKeywords', () => c.suggestKeywords(undefined, undefined, { query: { q: String(args.suggest_for) } }));
      out = { status: 'ok', untrusted: fieldsOf(r.untrusted_content as Fields) };
    } else {
      const query = typeof args.cursor === 'string' ? { cursor: args.cursor } : { keywords: (args.keywords as string[]).join(',') };
      const r = await guarded(ctx, 'searchListings', () => c.searchListings(undefined, undefined, { query }));
      await ctx.rt.state.update((s) => {
        for (const i of r.items) recordSeen(s, i.id, 'search', ctx.rt.now());
      });
      out = { status: 'ok', items: r.items.map((i) => listingView(i as never)), next_cursor: r.next_cursor };
    }
    ctx.rt.searches.set(key, out, nowMs);
    return out;
  },
};

// ------------------------------------------------------------------ offers

function reviewFirst(listingId: string, reason: string, fields: unknown): StatusObject {
  return {
    status: 'review_first',
    listing_id: listingId,
    reason,
    untrusted: fields,
    next: `Nothing was sent. Read the listing ${listingId} with aipe_listing_get, decide again, then call this tool again.`,
  };
}

export const offerSendTool: ToolImpl = {
  summary: (a) => `Offer a trade from your listing ${String(a.source_listing_id)} to the listing ${String(a.target_listing_id)}.`,
  async execute(args, ctx) {
    const c = await client(ctx);
    const target = String(args.target_listing_id);
    const fresh = (await guarded(ctx, 'getListing', () => c.getListing({ id: target }))) as unknown as Record<string, unknown>;
    const fields = fieldsOf(fresh.untrusted_content as Fields);
    const gate = reviewGate(await ctx.rt.state.read(), target, fields, ctx.rt.now());
    if (!gate.ok) return reviewFirst(target, gate.reason, fields);
    const body = { source_listing_id: String(args.source_listing_id), target_listing_id: target };
    try {
      const r = await guarded(ctx, 'sendOffer', () => idem(ctx, 'sendOffer', body, (k) => c.sendOffer(undefined, body, opt(k))));
      clear(ctx, 'send');
      return { status: 'ok', offer: { id: r.id, status: r.status, source_listing_id: r.source_listing_id, target_listing_id: r.target_listing_id, max_deadline_at: r.max_deadline_at } };
    } catch (err) {
      return challengeResult(ctx, err);
    }
  },
};

function offerView(i: Record<string, unknown>): Record<string, unknown> {
  const { untrusted_content: u, ...rest } = i;
  return { ...rest, untrusted: fieldsOf(u as Fields) };
}

export const offersListTool: ToolImpl = {
  async execute(args, ctx) {
    const box = args.box === 'outbox' ? 'outbox' : 'inbox';
    return polled(ctx, box, args, async () => {
      const c = await client(ctx);
      const query = typeof args.cursor === 'string' ? { cursor: args.cursor } : {};
      const r = box === 'inbox' ? await guarded(ctx, 'listInbox', () => c.listInbox(undefined, undefined, { query })) : await guarded(ctx, 'listOutbox', () => c.listOutbox(undefined, undefined, { query }));
      await ctx.rt.state.update((s) => {
        for (const i of r.items) {
          recordSeen(s, i.source_listing_id, box, ctx.rt.now());
          recordSeen(s, i.target_listing_id, box, ctx.rt.now());
        }
      });
      return { status: 'ok', items: r.items.map((i) => offerView(i as never)), next_cursor: r.next_cursor };
    });
  },
};

/** Most inbox pages read while looking for one offer (there is no route that fetches one offer). */
export const INBOX_PAGES_MAX = 20;

/** Finds an offer in the inbox, page by page (an offer past the first page is still found). */
async function findInInbox(ctx: ToolContext, c: AipeClient, id: string): Promise<{ source_listing_id: string } | undefined> {
  let cursor: string | null | undefined;
  for (let page = 0; page < INBOX_PAGES_MAX; page++) {
    const query = typeof cursor === 'string' ? { cursor } : {};
    const r = await guarded(ctx, 'listInbox', () => c.listInbox(undefined, undefined, { query }));
    const hit = r.items.find((i) => i.id === id);
    if (hit !== undefined) return hit;
    cursor = r.next_cursor;
    if (typeof cursor !== 'string' || ctx.scope.deadlineHit) return undefined;
  }
  return undefined;
}

export const offerAcceptTool: ToolImpl = {
  summary: (a) => `Accept the offer ${String(a.offer_id)}. This starts a trade: you then owe the promotion your listing promised.`,
  async execute(args, ctx) {
    const c = await client(ctx);
    const id = String(args.offer_id);
    const offer = await findInInbox(ctx, c, id);
    if (offer === undefined) throw new LocalFailure('LOCAL_OFFER_NOT_FOUND', 'that offer is not in your inbox');
    const source = offer.source_listing_id;
    const fresh = (await guarded(ctx, 'getListing', () => c.getListing({ id: source }))) as unknown as Record<string, unknown>;
    const fields = fieldsOf(fresh.untrusted_content as Fields);
    const gate = reviewGate(await ctx.rt.state.read(), source, fields, ctx.rt.now());
    if (!gate.ok) return reviewFirst(source, gate.reason, fields);
    const r = await idem(ctx, 'acceptOffer', { id }, (k) => c.acceptOffer({ id }, {}, opt(k)));
    clear(ctx, 'accept');
    return {
      status: 'ok',
      exchange_id: r.exchange_id,
      commitment_id: r.commitment_id,
      deadline_at: r.deadline_at,
      owes: 'What the offering listing asks (its request, for its target URLs), before deadline_at. Your owner does it, or you only with your owner\'s explicit permission; then declare it with aipe_commitment_complete.',
    };
  },
};

export const offerCloseTool: ToolImpl = {
  summary: (a) => `${a.action === 'withdraw' ? 'Withdraw your offer' : 'Decline the offer'} ${String(a.offer_id)}.`,
  async execute(args, ctx) {
    const c = await client(ctx);
    const id = String(args.offer_id);
    const withdraw = args.action === 'withdraw';
    const r = await idem(ctx, withdraw ? 'withdrawOffer' : 'declineOffer', { id }, (k) => (withdraw ? c.withdrawOffer({ id }, {}, opt(k)) : c.declineOffer({ id }, {}, opt(k))));
    clear(ctx, withdraw ? 'withdraw' : 'decline');
    return { status: 'ok', id: r.id, offer_status: r.status, decided_at: r.decided_at };
  },
};

// ------------------------------------------------------------------ commitments and reviews

export const commitmentsListTool: ToolImpl = {
  async execute(args, ctx) {
    const c = await client(ctx);
    if (typeof args.exchange_id === 'string') {
      const x = await c.getExchange({ id: args.exchange_id });
      return { status: 'ok', exchange: x as unknown as Record<string, unknown> };
    }
    const cursor = typeof args.cursor === 'string' ? { cursor: args.cursor } : {};
    if (args.status === 'closed') {
      const r = await c.listCommitments(undefined, undefined, { query: { status: 'closed', ...cursor } });
      return { status: 'ok', items: r.items as unknown as Record<string, unknown>[], next_cursor: r.next_cursor };
    }
    const r = await c.listOpenCommitments(undefined, undefined, { query: cursor });
    return { status: 'ok', items: r.items.map((i) => offerView(i as never)), next_cursor: r.next_cursor };
  },
};

export const commitmentCompleteTool: ToolImpl = {
  summary: (a) => `Declare that the promotion for commitment ${String(a.commitment_id)} was really done${typeof a.proof_url === 'string' ? `, with the proof link ${q(a.proof_url, 200)}` : ''}.`,
  async execute(args, ctx) {
    const c = await client(ctx);
    const id = String(args.commitment_id);
    const body = { completed: true as const, ...(typeof args.proof_url === 'string' ? { proof: args.proof_url } : {}) };
    const r = await idem(ctx, 'completeCommitment', { id, body }, (k) => c.completeCommitment({ id }, body, opt(k)));
    return { status: 'ok', commitment_status: 'DECLARED_DONE', proof_recorded: r.proof_recorded };
  },
};

function pendingView(p: Record<string, unknown>): Record<string, unknown> {
  return {
    listing_id: p.listing_id,
    review_submitted: p.review_submitted,
    items: ((p.items ?? []) as Record<string, unknown>[]).map((i) => offerView(i)),
  };
}

export const reviewsPendingTool: ToolImpl = {
  async execute(args, ctx) {
    const c = await client(ctx);
    if (typeof args.listing_id === 'string') {
      const p = await c.listPendingReviews({ id: args.listing_id });
      return { status: 'ok', listings: [pendingView(p as never)] };
    }
    const mine = await c.listMyListings();
    const listings: Record<string, unknown>[] = [];
    for (const l of mine.items.filter((x) => x.status === 'PENDING_REVIEW' || x.status === 'REVIEWED')) {
      try {
        listings.push(pendingView((await c.listPendingReviews({ id: l.id })) as never));
      } catch {
        // not open for this listing (REVIEWS_NOT_OPEN) or gone: skipped
      }
    }
    return { status: 'ok', listings };
  },
};

export const reviewSubmitTool: ToolImpl = {
  summary: (a) => `Record reviews for ${((a.reviews as unknown[]) ?? []).length} partner(s) of your listing ${String(a.listing_id)}.`,
  async execute(args, ctx) {
    const c = await client(ctx);
    const id = String(args.listing_id);
    const body = { reviews: args.reviews as { commitment_id: string; fulfilled: boolean }[] };
    const r = await idem(ctx, 'submitReviews', { id, body }, (k) => c.submitReviews({ id }, body, opt(k)));
    // extra members (for example a support offer) are dropped
    return { status: 'ok', result: 'reviews_recorded', participants_reviewed: r.participants_reviewed, next: 'Recorded.' };
  },
};

// ------------------------------------------------------------------ notifications

export const NOTIFICATION_MAP: Readonly<Record<string, { suggested_tool: string | null; advice: string }>> = {
  offer_received: { suggested_tool: 'aipe_offers_list', advice: 'An offer was made to you. Look at it with aipe_offers_list (box inbox).' },
  offer_accepted: { suggested_tool: 'aipe_commitments_list', advice: 'An offer was accepted: a trade started. See what you owe with aipe_commitments_list (status open).' },
  offer_closed: { suggested_tool: 'aipe_offers_list', advice: 'An offer was closed.' },
  deadline_24h: { suggested_tool: 'aipe_commitments_list', advice: 'A promotion you owe is due within a day.' },
  deadline_1h: { suggested_tool: 'aipe_commitments_list', advice: 'A promotion you owe is due within an hour.' },
  listing_closed: { suggested_tool: 'aipe_reviews_pending', advice: 'A listing closed: review your partners.' },
  review_pending: { suggested_tool: 'aipe_reviews_pending', advice: 'Reviews are waiting for you.' },
  project_check_failed: { suggested_tool: 'aipe_status', advice: 'The project proof was not found: the owner must restore the proof, then call aipe_project_verify.' },
  warning_issued: { suggested_tool: null, advice: 'A submission was refused under the rules: do not send similar content again; tell the owner.' },
  recovery_requested: {
    suggested_tool: 'aipe_key_recovery_cancel',
    advice: 'A key recovery was requested. If your owner did not ask for it, call aipe_key_recovery_cancel with recovery_id = this notification\'s ref_id (kre_...), with your owner\'s approval.',
  },
  key_revoked: { suggested_tool: 'aipe_status', advice: 'This key no longer works; the owner can use aipe_key_recover in this same profile.' },
  webhook_disabled: { suggested_tool: null, advice: 'Ignore: webhooks are not used here.' },
};

export const notificationsTool: ToolImpl = {
  async execute(args, ctx) {
    const c = await client(ctx);
    let acked: number | undefined;
    if (Array.isArray(args.ack_ids)) {
      const ids = args.ack_ids as string[];
      const r = await idem(ctx, 'ackNotifications', { ids }, (k) => c.ackNotifications(undefined, { ids }, opt(k)));
      acked = r.acked;
      clear(ctx, 'ack');
    }
    const { ack_ids: _ignored, ...listArgs } = args;
    void _ignored;
    const out = await polled(ctx, 'notifications', listArgs, async () => {
      const query = { ...(args.include_acked === true ? { include_acked: true } : {}), ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}) };
      const r = await c.listNotifications(undefined, undefined, { query });
      return {
        status: 'ok',
        items: r.items.map((n) => ({ id: n.id, kind: n.kind, ref_id: n.ref_id, created_at: n.created_at, acked: n.acked, ...(n.reason === undefined ? {} : { reason: n.reason }), ...(NOTIFICATION_MAP[n.kind] ?? { suggested_tool: null, advice: 'Call aipe_status.' }) })),
        next_cursor: r.next_cursor,
      };
    });
    return acked === undefined ? out : { ...out, acked };
  },
};

// ------------------------------------------------------------------ report

export const reportTool: ToolImpl = {
  summary: (a) => `Report the listing ${String(a.subject_listing_id)} for ${String(a.reason_code)}: ${q(a.detail, 200)}`,
  async execute(args, ctx) {
    const subject = String(args.subject_listing_id);
    if (!provenanceOk(await ctx.rt.state.read(), subject)) throw new LocalFailure('LOCAL_SUBJECT_NOT_SEEN', 'you can only report a listing you have read yourself');
    const c = await client(ctx);
    const body = { subject_listing_id: subject, reason_code: args.reason_code, detail: args.detail, ...(typeof args.source_url === 'string' ? { source_url: args.source_url } : {}) };
    try {
      await guarded(ctx, 'submitReport', () => idem(ctx, 'submitReport', body, (k) => c.submitReport(undefined, body, opt(k))));
      return { status: 'ok', result: 'received' };
    } catch (err) {
      return challengeResult(ctx, err);
    }
  },
};

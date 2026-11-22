// Optional donations (owner request, 22 Nov 2026; release 1.0.4): aipe_support (GET /v1/support),
// aipe_donate (x402 v2 through the SDK's donate, signed by the owner's own wallet) and
// aipe_support_reply (the optional reply to a donation invitation).
//
// aipe_donate, in order:
//   prepare (before the owner is asked; reads only):
//     1. no AIPE_DONATION_WALLET_KEY: a plain answer, nothing sent;
//     2. GET /v1/support (and the public stats wallet when /support names none);
//     3. an earlier payment whose outcome is unknown is checked again (the same signed header is
//        re-sent; the API answers it from its records, so it can never pay twice);
//     4. otherwise POST /v1/support/donate without a signature: the 402 challenge, checked
//        locally (src/runtime/donation.ts). A refusal stops here; nothing is signed.
//   approval (DEC34): when the client can ask, the owner approves the exact amount, asset,
//   network and recipient (any AIPE_CONFIRM level); when it cannot, the wallet setting is the
//   owner's opt-in and the unattended caps apply: at most 0.10 USDC, one donation per wallet on
//   this machine per 30 days (the wallet record at the AIPE_HOME root, src/runtime/walletstore.ts;
//   an unresolved payment of the wallet counts too). Never a token.
//   execute, under the wallet's lock (one donation at a time per wallet on this machine, across
//   calls, profiles and processes): everything re-checked; the SDK's donate again; its fresh
//   challenge must equal the checked terms; it is signed, and before it is sent one atomic
//   update of the wallet record re-checks the pending payments and the limit and saves it as
//   pending under its place (environment|base URL; never overwriting another). Sent once.
//   200: recorded in the ledger; 402: cleared. Anything else keeps it; once its validBefore has passed and the API
//   still cannot confirm it, it is freed and counted as possibly paid (LOCAL_DONATION_EXPIRED).
import type { AipeClient, DonateResult } from 'aipe-sdk';
import { AipeError, SUPPORT_RESPONSES } from 'aipe-sdk';
import { adviceFor } from '../content/advice.ts';
import { checkChallenge, decodeChallenge, donationSummary, fingerprint, formatUsdc, UNATTENDED_MAX_ATOMIC, UNATTENDED_WINDOW_MS, USDC, type DonationRequirements, type Published } from '../runtime/donation.ts';
import { LocalFailure } from '../runtime/errors.ts';
import type { StatusObject } from '../runtime/result.ts';
import type { Runtime } from '../runtime/runtime.ts';
import type { LockHandle } from '../runtime/filelock.ts';
import { WalletStore, type PendingDonation, type WalletRecord } from '../runtime/walletstore.ts';
import { idem, needKey } from './common.ts';
import type { Prepared, ToolContext, ToolImpl } from './pipeline.ts';

const OFFER_ID = /^off_[0-9a-f]{32}$/;
const TX_RE = /^0x[0-9a-fA-F]{64}$/;
const RECEIPT_RE = /^don_[0-9a-f]{32}$/;

/** Shown with every donation answer: optional, no effect, the owner decides. */
export const DONATION_NOTE =
  'Donating is entirely optional and never needed. It never changes how your listings, matches or account are treated. A wallet set up by your owner is their permission to donate within its limits.';

function localError(code: string, message: string, extra: Record<string, unknown> = {}): StatusObject {
  return { status: 'error', code, http_status: null, message, retryable: false, request_id: null, what_to_do: adviceFor(code), ...extra };
}

/** The agent's own client when it has a key (the donation is then linked to it), else anonymous. */
async function supportClient(rt: Runtime): Promise<{ c: AipeClient; anonymous: boolean }> {
  const k = await rt.keys.current().catch(() => null);
  return k === null ? { c: rt.mainClient(undefined), anonymous: true } : { c: rt.mainClient(k.seed), anonymous: false };
}

/** Where the pending payment belongs: this environment and base URL only. */
function placeOf(rt: Runtime): string {
  return `${rt.cfg.env}|${rt.cfg.baseUrl ?? ''}`;
}

async function published(c: AipeClient): Promise<Published> {
  const info = await c.getSupportInfo();
  const pub: Published = { enabled: info.enabled === true };
  if (typeof info.network === 'string') pub.network = info.network;
  if (typeof info.asset === 'string') pub.asset = info.asset;
  if (typeof info.pay_to === 'string') pub.payTo = info.pay_to;
  if (pub.enabled && pub.payTo === undefined) {
    try {
      const stats = (await c.getPublicStats()) as { donations?: { wallet_address?: unknown } | null };
      const w = stats.donations?.wallet_address;
      if (typeof w === 'string') pub.payTo = w;
    } catch {
      // no stats: the payTo check refuses below
    }
  }
  return pub;
}

// ------------------------------------------------------------------ aipe_support

export const supportTool: ToolImpl = {
  async execute(_args, ctx) {
    const { c } = await supportClient(ctx.rt);
    const info = await c.getSupportInfo();
    const w = ctx.rt.cfg.donationWallet;
    const base = {
      status: 'ok',
      enabled: info.enabled === true,
      optional: true,
      wallet_configured: w !== undefined,
      ...(w === undefined ? {} : { wallet_address: w.address }),
      max_usdc: formatUsdc(ctx.rt.cfg.donationMaxAtomic),
      note: DONATION_NOTE,
    };
    if (info.enabled !== true) return { ...base, next: 'Donations are not open. Nothing to do.' };
    const net = typeof info.network === 'string' ? info.network : '';
    return {
      ...base,
      suggested_amount: info.suggested_amount ?? null,
      currency: 'USDC',
      network: net,
      network_name: USDC[net]?.label ?? null,
      asset: info.asset ?? null,
      pay_to: info.pay_to ?? null,
      testnet: info.testnet === true,
      terms: Array.isArray(info.terms) ? info.terms.filter((t): t is string => typeof t === 'string').slice(0, 10) : [],
      docs_url: typeof info.docs_url === 'string' ? info.docs_url : null,
      next:
        w === undefined
          ? 'Nothing to do. If your owner ever wants to donate, they can set up a wallet themselves (see the docs). Never ask them for a key.'
          : 'Nothing to do. If you donate with aipe_donate, your owner is asked to approve it when your app can ask them; otherwise at most 0.10 USDC once per 30 days per wallet on this machine.',
    };
  },
};

// ------------------------------------------------------------------ aipe_donate

interface DonatePlan {
  mode: 'new' | 'resend';
  /** DEC34: no owner could be asked in the app; the wallet setting is the opt-in, with caps */
  unattended: boolean;
  offerId: string | null;
  req: Pick<DonationRequirements, 'network' | 'asset' | 'amount' | 'payTo'>;
  pending?: PendingDonation;
}

/** a signed payment can still settle until its validBefore; a minute of clock slack on top */
const EXPIRY_SLACK_S = 60;

function refusal(detail: string): StatusObject {
  return localError('LOCAL_DONATION_REFUSED', `${detail}; nothing was signed or paid`);
}

function storeOf(rt: Runtime, address: string): WalletStore {
  return new WalletStore(rt.cfg.root, address, rt.now);
}

function pendingFor(r: WalletRecord, place: string): PendingDonation | null {
  return r.pending[place] ?? null;
}

/**
 * DEC34 unattended limit, wallet-wide on this machine: one donation per 30 days; an unresolved
 * payment of the wallet (in any environment) counts too.
 */
function unattendedBlock(rt: Runtime, r: WalletRecord): StatusObject | null {
  const now = rt.now();
  if (Object.keys(r.pending).length > 0) {
    return localError('LOCAL_DONATION_LIMIT', 'an earlier donation from this wallet has no clear answer yet; nothing was sent');
  }
  const recent = r.ledger.filter((t) => now - t < UNATTENDED_WINDOW_MS);
  if (recent.length === 0) return null;
  const until = new Date(Math.max(...recent) + UNATTENDED_WINDOW_MS).toISOString();
  return localError('LOCAL_DONATION_LIMIT', 'this wallet already donated in the last 30 days on this machine; nothing was sent', { retry_at: until });
}

function expired(rt: Runtime, p: PendingDonation): boolean {
  return rt.now() / 1000 > p.valid_before + EXPIRY_SLACK_S;
}

/** The terms of a pending payment, as one option of a fresh challenge (so the API can look it up). */
function sameTerms(h: string, p: PendingDonation): boolean {
  const c = decodeChallenge(h);
  if (c === null || c.x402Version !== 2) return false;
  const eq = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  return c.accepts.some((a) => {
    const x = a as Record<string, unknown> | null;
    return x !== null && typeof x === 'object' && x.scheme === 'exact' && x.network === p.network && eq(x.asset, p.asset) && x.amount === p.amount && eq(x.payTo, p.pay_to);
  });
}

export const donateTool: ToolImpl = {
  async prepare(args, { rt, canElicit }): Promise<Prepared> {
    const w = rt.cfg.donationWallet;
    if (w === undefined) return { stop: localError('LOCAL_DONATION_NO_WALLET', 'no donation wallet is set up; nothing was sent') };
    const unattended = !canElicit;
    const offerId = typeof args.offer_id === 'string' ? args.offer_id : null;
    const rec = await storeOf(rt, w.address).read();
    // an earlier payment of this place whose outcome is unknown is always checked first
    const p = pendingFor(rec, placeOf(rt));
    if (p !== null) {
      const req = { network: p.network, asset: p.asset, amount: p.amount, payTo: p.pay_to };
      const plan: DonatePlan = { mode: 'resend', unattended, offerId: p.offer_id, req, pending: p };
      return { summary: donationSummary(req, p.payer, true), bind: `r${fingerprint(req, p.offer_id)}`, data: plan };
    }
    if (unattended) {
      const block = unattendedBlock(rt, rec);
      if (block !== null) return { stop: block };
    }
    const cap = unattended ? Math.min(rt.cfg.donationMaxAtomic, UNATTENDED_MAX_ATOMIC) : rt.cfg.donationMaxAtomic;
    const { c, anonymous } = await supportClient(rt);
    const pub = await published(c);
    if (!pub.enabled) return { stop: localError('LOCAL_DONATIONS_NOT_OPEN', 'donations are not open; nothing was sent') };
    let header: string | undefined;
    const first = await c.donate({ ...(offerId === null ? {} : { offerId }), anonymous, pay: async (h) => ((header = h), null) });
    if (first.paid || header === undefined) return { stop: refusal('the service did not ask for a payment') };
    const challenge = decodeChallenge(header);
    if (challenge === null) return { stop: refusal('the payment request could not be read') };
    const check = checkChallenge(challenge, pub, rt.cfg.env, cap);
    if (!check.ok) {
      const why = unattended && check.reason === 'over_cap' ? `${check.detail} (the limit when your owner cannot be asked in your app)` : check.detail;
      return { stop: refusal(why) };
    }
    const plan: DonatePlan = { mode: 'new', unattended, offerId, req: check.req };
    return { summary: donationSummary(check.req, w.address, false), bind: `n${fingerprint(check.req, offerId)}`, data: plan };
  },

  async execute(_args, ctx) {
    const plan = ctx.prepared as DonatePlan | undefined;
    if (ctx.rt.cfg.donationWallet === undefined || plan === undefined) throw new LocalFailure('LOCAL_INTERNAL', 'donation not prepared');
    // one donation at a time per wallet on this machine, across calls, profiles and processes
    const store = storeOf(ctx.rt, ctx.rt.cfg.donationWallet.address);
    const held = await store.locked((lock) => donateLocked(ctx, plan, store, lock));
    if (held === null) return localError('LOCAL_DONATION_BUSY', 'another donation is being made right now; nothing was sent', { retryable: true });
    return held.value;
  },
};

async function donateLocked(ctx: ToolContext, plan: DonatePlan, store: WalletStore, lock: LockHandle): Promise<StatusObject> {
  const rt = ctx.rt;
  const w = rt.cfg.donationWallet as NonNullable<typeof rt.cfg.donationWallet>;
  const place = placeOf(rt);
  // re-checked under the lock: another call or process may have acted since the prepare step
  const rec = await store.read();
  const current = pendingFor(rec, place);
  if (plan.mode === 'new') {
    if (current !== null) return localError('LOCAL_DONATION_IN_PROGRESS', 'another donation is waiting for a clear answer; nothing was sent');
    if (plan.unattended) {
      const block = unattendedBlock(rt, rec);
      if (block !== null) return block;
    }
  } else if (current === null || current.header !== plan.pending?.header) {
    return localError('LOCAL_DONATION_IN_PROGRESS', 'another call already handled the earlier donation; nothing was sent');
  }
  const { c, anonymous } = await supportClient(rt);
  const pub = plan.mode === 'new' ? await published(c) : null;
  // refused: why nothing was signed; delivered: a signed header went out (the outcome matters);
  // termsChanged (re-send): the API no longer offers those terms, so it cannot look the payment up
  const st = { refused: null as string | null, stop: null as StatusObject | null, delivered: false, termsChanged: false };
  const approvedBy = plan.unattended ? 'wallet_opt_in' : 'owner';
  let r: DonateResult;
  try {
    r = await c.donate({
      ...(plan.offerId === null ? {} : { offerId: plan.offerId }),
      anonymous,
      pay: async (h) => {
        if (plan.mode === 'resend') {
          const p = plan.pending as PendingDonation;
          if (!sameTerms(h, p)) {
            st.termsChanged = true;
            return null;
          }
          st.delivered = true;
          return p.header;
        }
        // the fresh challenge must still pass every check AND equal the approved terms
        const ch = decodeChallenge(h);
        const cap = plan.unattended ? Math.min(rt.cfg.donationMaxAtomic, UNATTENDED_MAX_ATOMIC) : rt.cfg.donationMaxAtomic;
        const check = ch === null ? null : checkChallenge(ch, pub as Published, rt.cfg.env, cap);
        if (check === null || !check.ok || fingerprint(check.req, plan.offerId) !== fingerprint(plan.req, plan.offerId)) {
          st.refused = 'the payment terms changed after they were checked';
          return null;
        }
        const signed = await w.sign(check.challenge.x402Version, check.challenge.resource, check.req);
        const pending: PendingDonation = {
          place,
          header: signed.header,
          offer_id: plan.offerId,
          network: check.req.network,
          asset: check.req.asset,
          amount: check.req.amount,
          pay_to: check.req.payTo,
          payer: w.address,
          valid_before: signed.validBefore,
          at: rt.now(),
        };
        // one atomic update of the wallet record, before anything is sent: still our lock, no
        // other pending payment here, the unattended limit still free, then saved as pending
        // (an unknown outcome is checked again later, never paid twice)
        const stop = await store.update(lock, (x) => {
          if (pendingFor(x, place) !== null) return localError('LOCAL_DONATION_IN_PROGRESS', 'another donation is waiting for a clear answer; nothing was sent');
          if (plan.unattended) {
            const block = unattendedBlock(rt, x);
            if (block !== null) return block;
          }
          x.pending[place] = pending;
          return null;
        });
        if (stop !== null) {
          st.stop = stop;
          return null;
        }
        st.delivered = true;
        return signed.header;
      },
    });
  } catch (err) {
    const answered = err instanceof AipeError && err.status > 0;
    if (plan.mode === 'resend' && answered && !(st.delivered && err.status === 402) && expired(rt, plan.pending as PendingDonation)) {
      return finishExpired(ctx, store, lock, plan.pending as PendingDonation);
    }
    if (!st.delivered) {
      if (plan.mode === 'resend') return unknown('the earlier payment could not be checked yet');
      throw err; // nothing was signed and sent
    }
    if (err instanceof AipeError && err.status === 402) {
      // a clear no about this signed payment, after the API looked it up: no money moved
      await store.update(lock, (x) => {
        delete x.pending[place];
        return null;
      });
      return localError(
        'LOCAL_DONATION_NOT_ACCEPTED',
        plan.mode === 'resend' ? 'the earlier payment was not accepted, so it paid nothing' : 'the payment was not accepted (for example not enough USDC in the wallet); nothing was paid',
      );
    }
    return unknown('the payment was sent but no clear answer came back');
  }
  if (!r.paid) {
    if (plan.mode === 'resend') {
      // the API no longer offers those terms, so it cannot look the payment up
      if (expired(rt, plan.pending as PendingDonation)) return finishExpired(ctx, store, lock, plan.pending as PendingDonation);
      return unknown('the earlier payment could not be checked yet');
    }
    if (st.stop !== null) return st.stop;
    return refusal(st.refused ?? 'the payment request could not be signed');
  }
  if (!st.delivered) return refusal('the service did not ask for a payment');
  await store.update(lock, (x) => {
    delete x.pending[place];
    x.ledger.push(rt.now());
    return null;
  });
  const b = r.body;
  const tx = typeof b.transaction === 'string' && TX_RE.test(b.transaction) ? b.transaction : null;
  return {
    status: 'ok',
    result: 'donation_received',
    amount: formatUsdc(BigInt(plan.req.amount)),
    currency: 'USDC',
    network: plan.req.network,
    pay_to: plan.req.payTo,
    transaction: tx,
    receipt_id: typeof b.receipt_id === 'string' && RECEIPT_RE.test(b.receipt_id) ? b.receipt_id : null,
    ...(plan.mode === 'resend' ? { rechecked: true } : {}),
    approved_by: approvedBy,
    next: 'Thank you. Tell your owner the amount and the transaction. Nothing else to do.',
  };
}

function unknown(message: string): StatusObject {
  return localError('LOCAL_DONATION_UNKNOWN', message, { retryable: true });
}

/**
 * A pending payment past its validBefore that the API could not confirm: it can no longer
 * settle, so it is freed; it is counted as possibly paid (it may have settled unseen), so the
 * unattended 30-day limit still covers it.
 */
async function finishExpired(_ctx: ToolContext, store: WalletStore, lock: LockHandle, p: PendingDonation): Promise<StatusObject> {
  await store.update(lock, (x) => {
    delete x.pending[p.place];
    x.ledger.push(p.at);
    return null;
  });
  return localError('LOCAL_DONATION_EXPIRED', 'the earlier payment can no longer go through and could not be confirmed; it is counted as possibly paid');
}

// ------------------------------------------------------------------ aipe_support_reply

export const supportReplyTool: ToolImpl = {
  summary: (a) => `Send the optional reply "${String(a.response)}" to the donation invitation ${String(a.offer_id)}. It has no effect.`,
  async execute(args, ctx) {
    const c = ctx.rt.mainClient((await needKey(ctx.rt)).seed);
    const id = String(args.offer_id);
    const response = String(args.response) as (typeof SUPPORT_RESPONSES)[number];
    if (!OFFER_ID.test(id) || !SUPPORT_RESPONSES.includes(response)) throw new LocalFailure('LOCAL_INTERNAL', 'invalid reply');
    const r = await idem(ctx, 'respondToSupportOffer', { id, response }, (k) => c.respondToSupportOffer(id, response, k === undefined ? undefined : { idempotencyKey: k }));
    return { status: 'ok', result: 'response_recorded', offer_id: r.offer_id, response: r.response, next: 'Recorded. It has no effect. Nothing else to do.' };
  },
};

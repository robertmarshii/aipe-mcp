// Optional donations (owner request, 22 Nov 2026; release 1.0.4): the local safety checks on an
// x402 v2 PAYMENT-REQUIRED challenge before anything is signed. Pure code, no signing (the
// signer is src/donate/wallet.ts).
//
// A challenge is refused unless all of these hold:
//   - x402 version 2, scheme exact, EIP-3009 (never permit2, which can mean on-chain approvals);
//   - USDC on Base mainnet; on Base Sepolia too when AIPE_ENV is staging or test;
//   - network and asset equal what AIPE publishes in GET /v1/support;
//   - payTo equals the wallet address AIPE publishes (GET /v1/support pay_to, else the public
//     stats wallet_address); on Base mainnet (any AIPE_ENV or base URL) it must also equal
//     LIVE_PAY_TO, built in here (DEC34);
//   - the amount is a whole number of atomic units, above 0 and at most the cap
//     (AIPE_DONATION_MAX_USDC, default 0.10, never above 1.00).
import { createHash } from 'node:crypto';
import type { AipeEnv } from './config.ts';

export const USDC_DECIMALS = 6;
export const DEFAULT_MAX_ATOMIC = 100_000; // 0.10 USDC
export const HARD_MAX_ATOMIC = 1_000_000; // 1.00 USDC
/** DEC34: without an owner asked in the app, at most 0.10 USDC per donation ... */
export const UNATTENDED_MAX_ATOMIC = 100_000;
/** ... and at most one donation per wallet address in this window */
export const UNATTENDED_WINDOW_MS = 30 * 24 * 3600 * 1000;
/** DEC34: AIPE's donation address on Base mainnet. Any other mainnet recipient is refused, whatever the environment. */
export const LIVE_PAY_TO = '0x72DBacbC93FDdC7cb981896135A38d00fB6916DF';

/** USDC by CAIP-2 network: Base mainnet always; Base Sepolia only for staging and test. */
export const BASE_MAINNET = 'eip155:8453';
export const BASE_SEPOLIA = 'eip155:84532';
export const USDC: Readonly<Record<string, { asset: string; label: string; testnet: boolean }>> = {
  [BASE_MAINNET]: { asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', label: 'Base', testnet: false },
  [BASE_SEPOLIA]: { asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', label: 'Base Sepolia (testnet)', testnet: true },
};

export function allowedNetworks(env: AipeEnv): string[] {
  return env === 'staging' || env === 'test' ? [BASE_MAINNET, BASE_SEPOLIA] : [BASE_MAINNET];
}

/**
 * AIPE_DONATION_MAX_USDC as atomic units. A plain decimal with up to 6 places, above 0 and at
 * most 1.00; null when the value is not valid (the caller names the variable).
 */
export function parseMaxUsdc(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return DEFAULT_MAX_ATOMIC;
  const m = /^(\d{1,7})(?:\.(\d{1,6}))?$/.exec(raw.trim());
  if (m === null) return null;
  const atomic = Number(m[1]) * 10 ** USDC_DECIMALS + Number((m[2] ?? '').padEnd(USDC_DECIMALS, '0'));
  if (!Number.isSafeInteger(atomic) || atomic <= 0 || atomic > HARD_MAX_ATOMIC) return null;
  return atomic;
}

/** Atomic units as a decimal string with at least two places: 100000 -> "0.10". */
export function formatUsdc(atomic: bigint | number): string {
  const a = BigInt(atomic);
  const whole = a / 10n ** BigInt(USDC_DECIMALS);
  const frac = (a % 10n ** BigInt(USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${whole}.${frac}`;
}

export interface DonationRequirements {
  scheme: 'exact';
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface Challenge {
  x402Version: number;
  resource: unknown;
  accepts: unknown[];
}

/** What AIPE publishes about donations (GET /v1/support, plus the stats wallet as a fallback). */
export interface Published {
  enabled: boolean;
  network?: string;
  asset?: string;
  payTo?: string;
}

export type CheckResult =
  | { ok: true; req: DonationRequirements; challenge: Challenge }
  | { ok: false; reason: RefusalReason; detail: string };

export type RefusalReason = 'bad_challenge' | 'not_usdc_on_base' | 'not_published' | 'pay_to_mismatch' | 'over_cap';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT_RE = /^[1-9][0-9]{0,18}$/;

function same(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/** The PAYMENT-REQUIRED header value (base64 JSON), or null when it is not one. */
export function decodeChallenge(header: string): Challenge | null {
  if (header.length > 16_384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(header)) return null;
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  const c = v as Challenge | null;
  if (c === null || typeof c !== 'object' || typeof c.x402Version !== 'number' || !Array.isArray(c.accepts)) return null;
  return { x402Version: c.x402Version, resource: c.resource, accepts: c.accepts };
}

const refuse = (reason: RefusalReason, detail: string): CheckResult => ({ ok: false, reason, detail });

/** All the local checks above. Nothing is signed unless this answers ok. */
export function checkChallenge(c: Challenge, pub: Published, env: AipeEnv, maxAtomic: number): CheckResult {
  if (c.x402Version !== 2) return refuse('bad_challenge', 'not an x402 version 2 payment request');
  const nets = allowedNetworks(env);
  const candidates = c.accepts.filter((a): a is Record<string, unknown> => a !== null && typeof a === 'object' && (a as { scheme?: unknown }).scheme === 'exact');
  if (candidates.length === 0) return refuse('bad_challenge', 'no exact-scheme payment option');
  const a = candidates.find((x) => typeof x.network === 'string' && nets.includes(x.network) && same(x.asset, USDC[x.network]?.asset));
  if (a === undefined) return refuse('not_usdc_on_base', `the payment is not USDC on ${nets.map((n) => USDC[n]?.label).join(' or ')}`);
  const extra = (a.extra !== null && typeof a.extra === 'object' && !Array.isArray(a.extra) ? a.extra : {}) as Record<string, unknown>;
  if (extra.assetTransferMethod !== undefined && extra.assetTransferMethod !== 'eip3009') return refuse('bad_challenge', 'only a plain USDC authorisation is supported');
  if (typeof extra.name !== 'string' || typeof extra.version !== 'string') return refuse('bad_challenge', 'the payment request is incomplete');
  const maxTimeout = a.maxTimeoutSeconds;
  if (typeof maxTimeout !== 'number' || !Number.isInteger(maxTimeout) || maxTimeout < 1 || maxTimeout > 3600) return refuse('bad_challenge', 'the payment request has no valid time limit');
  if (typeof a.payTo !== 'string' || !ADDRESS_RE.test(a.payTo)) return refuse('bad_challenge', 'the payment request has no valid recipient');
  if (typeof a.amount !== 'string' || !AMOUNT_RE.test(a.amount)) return refuse('bad_challenge', 'the payment request has no valid amount');
  if (!pub.enabled || pub.network === undefined || pub.asset === undefined) return refuse('not_published', 'AIPE does not publish a donation network and asset');
  if (pub.network !== a.network || !same(pub.asset, a.asset)) return refuse('not_published', 'the payment network or asset differs from what AIPE publishes');
  if (pub.payTo === undefined || !ADDRESS_RE.test(pub.payTo)) return refuse('not_published', 'AIPE does not publish a donation wallet address');
  if (a.network === BASE_MAINNET && (!same(pub.payTo, LIVE_PAY_TO) || !same(a.payTo, LIVE_PAY_TO))) {
    return refuse('pay_to_mismatch', 'on Base mainnet the recipient must be the donation address built into this MCP server');
  }
  if (!same(pub.payTo, a.payTo)) return refuse('pay_to_mismatch', 'the recipient differs from the wallet address AIPE publishes');
  if (BigInt(a.amount) > BigInt(maxAtomic)) return refuse('over_cap', `the amount ${formatUsdc(BigInt(a.amount))} USDC is above the limit of ${formatUsdc(maxAtomic)} USDC`);
  const req: DonationRequirements = {
    scheme: 'exact',
    network: a.network as string,
    asset: a.asset as string,
    amount: a.amount,
    payTo: a.payTo,
    maxTimeoutSeconds: maxTimeout,
    extra: { name: extra.name, version: extra.version },
  };
  return { ok: true, req, challenge: c };
}

/** A short fingerprint of exactly what will be paid (binds an approval to these terms). */
export function fingerprint(req: Pick<DonationRequirements, 'network' | 'asset' | 'amount' | 'payTo'>, offerId: string | null): string {
  const material = [req.network, req.asset.toLowerCase(), req.amount, req.payTo.toLowerCase(), offerId ?? ''].join('|');
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32);
}

/** The owner's confirmation text: exact amount, asset, network and recipient. Static text and checked hex only. */
export function donationSummary(req: Pick<DonationRequirements, 'network' | 'asset' | 'amount' | 'payTo'>, payer: string, resend: boolean): string {
  const net = USDC[req.network]?.label ?? req.network;
  const what = `${formatUsdc(BigInt(req.amount))} USDC (asset ${req.asset} on ${net}, ${req.network}) to ${req.payTo}, the donation address AIPE publishes, from the wallet ${payer}`;
  return resend
    ? `Check again on your earlier donation of ${what}. This re-sends the same signed payment; it cannot pay twice.`
    : `Optional donation to the AI Agent Promotion Exchange: pay ${what}. One payment; it cannot be undone. It is entirely optional and changes nothing about how your listings, matches or account are treated.`;
}

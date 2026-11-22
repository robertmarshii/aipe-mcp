// The donation wallet (owner request, 22 Nov 2026; release 1.0.4). The ONLY module of the MCP
// server that signs anything itself: an x402 v2 "exact" EIP-3009 authorisation for an optional
// donation, with a payer key the owner sets in AIPE_DONATION_WALLET_KEY. Every other signature
// still comes from the SDK (check-no-signing allows the x402 and viem imports in this file only).
//
// The key is held in this closure only: never logged, returned, persisted or echoed. Its bytes
// are handed to the key ring so the frame redactor and the outgoing preflight block it like an
// agent key. Signing is local (typed data); no RPC, no transaction, no other network call.
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import type { DonationRequirements } from '../runtime/donation.ts';

export interface DonationWallet {
  /** the payer's public address (0x, checksummed) */
  readonly address: string;
  /** the raw key bytes, for the redactor and the preflight only */
  redactionSeed(): Uint8Array;
  /** the PAYMENT-SIGNATURE header value for exactly these requirements */
  sign(x402Version: number, resource: unknown, req: DonationRequirements): Promise<{ header: string; validBefore: number }>;
}

export const WALLET_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/** A wallet from a 0x-prefixed 32-byte hex key, or null when the key is not usable. */
export function walletFromKey(hex: string): DonationWallet | null {
  if (!WALLET_KEY_RE.test(hex)) return null;
  let account: ReturnType<typeof privateKeyToAccount>;
  try {
    account = privateKeyToAccount(hex as `0x${string}`);
  } catch {
    return null; // zero, or not below the curve order
  }
  const seed = Uint8Array.from(Buffer.from(hex.slice(2), 'hex'));
  return {
    address: account.address,
    redactionSeed: () => seed,
    async sign(x402Version, resource, req) {
      const client = new x402Client();
      // only the address and signTypedData: no readContract, so no on-chain extension is ever tried
      client.register(req.network as `${string}:${string}`, new ExactEvmScheme({ address: account.address, signTypedData: (m) => account.signTypedData(m as never) }));
      const payload = await client.createPaymentPayload({
        x402Version,
        resource: resource as never,
        accepts: [{ ...req, network: req.network as `${string}:${string}`, extra: { ...req.extra } }],
      });
      const auth = (payload.payload as { authorization?: { validBefore?: unknown } }).authorization;
      const validBefore = Number(auth?.validBefore ?? 0);
      return { header: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'), validBefore };
    },
  };
}

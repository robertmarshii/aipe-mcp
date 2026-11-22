// Outgoing-text leak preflight (plan §3.3, SAFETY 5). Every free-text field the MCP sends passes
// here first. Written from the plan's description, not from the server's scanner, and stricter
// than it (a superset): the server auto-revokes a leaked key, so we refuse before sending.
//
//   refuse          -> LOCAL_SECRET_IN_TEXT, nothing sent: private-key markers, or a local seed
//                      in any encoding (hex, base64, base64url at any alignment, PKCS#8 DER, JWK)
//   possible_secret -> the owner is asked directly (elicitation) or the tool refuses; never a
//                      model-confirmable token: any other 32-byte token, or a generic owner secret
import {
  containsSeed,
  hasGenericKeyMarker,
  normaliseForMatch,
  seedPatterns,
} from './keymaterial.ts';

export interface TextField {
  /** field name as the tool knows it, e.g. "agent_name" or "keywords[2]" */
  name: string;
  value: string;
}

export type PreflightResult =
  | { kind: 'ok' }
  | { kind: 'refuse'; field: string; reason: 'key_marker' | 'local_seed' }
  | { kind: 'possible_secret'; field: string; reason: 'token_32_bytes' | 'owner_secret' };

const GENERIC_SECRETS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abp]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/,
  /\b(?:password|passwd|pwd)\s*=/i,
];

/** Tokens that decode to exactly 32 bytes: 64 hex, 43 base64url, 43/44 base64. */
export function decode32(token: string): Uint8Array | null {
  if (/^[0-9a-fA-F]{64}$/.test(token)) return new Uint8Array(Buffer.from(token, 'hex'));
  if (/^[A-Za-z0-9_-]{43}$/.test(token)) return new Uint8Array(Buffer.from(token, 'base64url'));
  if (/^[A-Za-z0-9+/]{43}$/.test(token)) return new Uint8Array(Buffer.from(token, 'base64'));
  return null;
}

/**
 * Candidate tokens: runs of base64/base64url/hex characters ('=' padding is a separator, so
 * 44-character base64 shows as 43 characters), plus URL parts split on / ? & # = ; , and
 * whitespace (as the server's scanner does), so a value in a URL path segment or query value is
 * a candidate on its own.
 */
export function tokens(text: string): string[] {
  return [...text.split(/[^A-Za-z0-9+/_-]+/), ...text.split(/[/?&#=;,\s]+/)];
}

export function preflight(fields: readonly TextField[], seeds: readonly Uint8Array[]): PreflightResult {
  const patterns = seeds.map(seedPatterns);
  let possible: PreflightResult | null = null;
  for (const f of fields) {
    const text = f.value.normalize('NFKC');
    const compact = normaliseForMatch(text);
    if (hasGenericKeyMarker(compact)) return { kind: 'refuse', field: f.name, reason: 'key_marker' };
    const lower = compact.toLowerCase();
    if (patterns.some((p) => containsSeed(compact, lower, p))) return { kind: 'refuse', field: f.name, reason: 'local_seed' };
    for (const t of tokens(text)) {
      // a local seed in these encodings was already refused above (seed patterns are a superset)
      if (decode32(t) !== null) possible ??= { kind: 'possible_secret', field: f.name, reason: 'token_32_bytes' };
    }
    if (possible === null && GENERIC_SECRETS.some((re) => re.test(text))) {
      possible = { kind: 'possible_secret', field: f.name, reason: 'owner_secret' };
    }
  }
  return possible ?? { kind: 'ok' };
}

/** Flattens a tool's free-text inputs (strings at any depth, plus object keys) into named fields. */
export function textFields(input: Record<string, unknown>, names: readonly string[]): TextField[] {
  const out: TextField[] = [];
  const walk = (name: string, v: unknown): void => {
    if (typeof v === 'string') out.push({ name, value: v });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(`${name}[${i}]`, x));
    else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        out.push({ name: `${name} key`, value: k });
        walk(`${name}.${k}`, x);
      }
    }
  };
  for (const n of names) walk(n, input[n]);
  return out;
}

// Encodings of local key seeds, shared by the frame redactor (§3.2) and the outgoing preflight
// (§3.3). Only encodes and compares; never signs.

const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/** Generic private-key markers: PEM header, PKCS#8 Ed25519 head, OpenSSH head. */
export const PKCS8_ED25519_HEAD = 'MC4CAQAwBQYDK2VwBCIE';
export const OPENSSH_HEAD = 'b3BlbnNzaC1rZXktdjE';
/** Matches on text with all whitespace removed. */
export const PEM_PRIVATE_RE = /-----BEGIN[A-Z0-9]*PRIVATEKEY/i;

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function toUrl(s: string): string {
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The part of base64(prefix(a bytes) + seed) that depends only on the seed, for alignments
 * a = 0, 1, 2. Any base64 text that contains the seed at any byte offset contains one of these.
 */
export function alignedBase64Cores(seed: Uint8Array): string[] {
  const out: string[] = [];
  for (const a of [0, 1, 2]) {
    const buf = new Uint8Array(a + seed.length);
    buf.set(seed, a);
    const text = b64(buf);
    const startBits = 8 * a;
    const endBits = 8 * (a + seed.length);
    const first = Math.ceil(startBits / 6);
    const last = Math.floor(endBits / 6); // exclusive
    out.push(text.slice(first, last));
  }
  return out;
}

export interface SeedPatterns {
  /** compared against the lower-cased normalised text */
  hexLower: string;
  /** compared against the normalised text */
  exact: string[];
}

export function seedPatterns(seed: Uint8Array): SeedPatterns {
  const cores = alignedBase64Cores(seed);
  const der = new Uint8Array(PKCS8_PREFIX.length + seed.length);
  der.set(PKCS8_PREFIX, 0);
  der.set(seed, PKCS8_PREFIX.length);
  const exact = new Set<string>();
  for (const c of cores) {
    exact.add(c);
    exact.add(toUrl(c));
  }
  exact.add(b64(der).replace(/=+$/, ''));
  exact.add(toUrl(b64(der)));
  exact.add(`"d":"${toUrl(b64(seed))}`);
  return { hexLower: Buffer.from(seed).toString('hex'), exact: [...exact] };
}

/**
 * Frame normalisation before matching: NFKC, JSON escapes for line breaks and slashes removed,
 * then all whitespace removed. A PEM wrapped at 64 columns inside a JSON string is caught.
 */
export function normaliseForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\\+[nrt]/g, '')
    .replace(/\\\//g, '/')
    .replace(/\s+/g, '');
}

export function containsSeed(normalised: string, lower: string, p: SeedPatterns): boolean {
  if (lower.includes(p.hexLower)) return true;
  return p.exact.some((x) => normalised.includes(x));
}

export function hasGenericKeyMarker(normalised: string): boolean {
  return normalised.includes(PKCS8_ED25519_HEAD) || normalised.includes(OPENSSH_HEAD) || PEM_PRIVATE_RE.test(normalised);
}

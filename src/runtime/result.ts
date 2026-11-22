// CallToolResult builder (plan §2.1, §3.1). structuredContent is the status object. When it holds
// third-party data, the first text block is the same object with every `untrusted` value replaced
// by a pointer, followed by one fenced block holding the cleaned untrusted values; otherwise the
// text block is the plain object. isError is set only for status "error".
// The whole frame (structuredContent plus every text block) is capped at about 50 KB: the longest
// list is shortened and `truncated` set; if that is not enough, LOCAL_RESULT_TOO_LARGE.
import { adviceFor } from '../content/advice.ts';
import { sanitiseDeep } from './sanitise.ts';
import { wrapUntrusted } from './untrusted.ts';

export const RESULT_CAP_BYTES = 50_000;
const POINTER = '[third-party data: see the fenced block below]';

export interface StatusObject {
  status: string;
  [key: string]: unknown;
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent: StatusObject;
  isError: boolean;
}

/** A copy with every `untrusted` subtree cleaned. */
function cleanUntrusted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(cleanUntrusted);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = k === 'untrusted' ? sanitiseDeep(x).value : cleanUntrusted(x);
    return out;
  }
  return v;
}

/** The (already cleaned) untrusted values of an object, by path. */
function untrustedOf(v: unknown, path = '', out: { path: string; value: unknown }[] = []): { path: string; value: unknown }[] {
  if (Array.isArray(v)) v.forEach((x, i) => untrustedOf(x, `${path}[${i}]`, out));
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const p = path === '' ? k : `${path}.${k}`;
      if (k === 'untrusted') out.push({ path: p, value: x });
      else untrustedOf(x, p, out);
    }
  }
  return out;
}

function pointerCopy(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(pointerCopy);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = k === 'untrusted' ? POINTER : pointerCopy(x);
    return out;
  }
  return v;
}

/** The longest array anywhere in the value (by element count), or null. */
function longestArray(v: unknown): unknown[] | null {
  let best: unknown[] | null = null;
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) {
      if (best === null || x.length > best.length) best = x;
      x.forEach(walk);
    } else if (x !== null && typeof x === 'object') {
      Object.values(x).forEach(walk);
    }
  };
  walk(v);
  return best;
}

/** Builds the frame for an already cleaned status object (no cap). */
function frame(obj: StatusObject): ToolResult {
  const found = untrustedOf(obj);
  const content: { type: 'text'; text: string }[] = [{ type: 'text', text: JSON.stringify(found.length > 0 ? pointerCopy(obj) : obj, null, 1) }];
  if (found.length > 0) content.push({ type: 'text', text: wrapUntrusted(found, true).block });
  return { content, structuredContent: obj, isError: obj.status === 'error' };
}

export function frameBytes(r: ToolResult): number {
  return Buffer.byteLength(JSON.stringify({ content: r.content, structuredContent: r.structuredContent, isError: r.isError }), 'utf8');
}

const TOO_LARGE: StatusObject = {
  status: 'error',
  code: 'LOCAL_RESULT_TOO_LARGE',
  http_status: null,
  message: 'the result was too large to return',
  retryable: false,
  request_id: null,
  what_to_do: adviceFor('LOCAL_RESULT_TOO_LARGE'),
};

export function toToolResult(obj: StatusObject, cap = RESULT_CAP_BYTES): ToolResult {
  const cleaned = cleanUntrusted(obj) as StatusObject;
  const first = frame(cleaned);
  if (frameBytes(first) <= cap) return first;
  const copy = structuredClone(cleaned);
  copy.truncated = true;
  for (;;) {
    const r = frame(copy);
    if (frameBytes(r) <= cap) return r;
    const arr = longestArray(copy);
    if (arr === null || arr.length === 0) break;
    arr.length = Math.floor(arr.length * 0.75);
  }
  return frame(TOO_LARGE);
}

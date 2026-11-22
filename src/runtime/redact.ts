// Frame redactor (plan §3.2, SAFETY 6). Wraps the stdio transport's send(), the single exit for
// every JSON-RPC frame (results, resources, prompts, elicitation requests, log and progress
// notifications, errors). Fails closed: on a match, or if the check itself throws, a response
// is replaced by a JSON-RPC error {code:-32603, message:"LOCAL_REDACTED"}; any other frame
// (notification or server-to-client request) is dropped. Only the code goes to stderr.
import { containsSeed, hasGenericKeyMarker, normaliseForMatch, seedPatterns, type SeedPatterns } from './keymaterial.ts';

export interface SeedSource {
  /** every local profile's seeds (key.pem, key.next.pem, key.old.pem) */
  seeds(): readonly Uint8Array[];
}

export class FrameMatcher {
  readonly #source: SeedSource;
  #cache = new Map<string, SeedPatterns>();

  constructor(source: SeedSource) {
    this.#source = source;
  }

  #patterns(): SeedPatterns[] {
    const out: SeedPatterns[] = [];
    const next = new Map<string, SeedPatterns>();
    for (const s of this.#source.seeds()) {
      const id = Buffer.from(s).toString('hex');
      const p = this.#cache.get(id) ?? seedPatterns(s);
      next.set(id, p);
      out.push(p);
    }
    this.#cache = next;
    return out;
  }

  /** true when the text must not leave the process */
  blocked(text: string): boolean {
    const normalised = normaliseForMatch(text);
    if (hasGenericKeyMarker(normalised)) return true;
    const lower = normalised.toLowerCase();
    return this.#patterns().some((p) => containsSeed(normalised, lower, p));
  }
}

export interface JsonRpcLike {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export type RedactLog = (code: 'LOCAL_REDACTED', detail: { kind: 'response' | 'notification' | 'request'; method?: string }) => void;

/** Decides what goes on the wire for one outgoing frame. */
export function redactFrame(message: JsonRpcLike, matcher: FrameMatcher): { send: JsonRpcLike | null; blocked: boolean } {
  let blocked: boolean;
  try {
    blocked = matcher.blocked(JSON.stringify(message));
  } catch {
    blocked = true;
  }
  if (!blocked) return { send: message, blocked: false };
  const isResponse = message.method === undefined && message.id !== undefined;
  if (isResponse) {
    return { send: { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32603, message: 'LOCAL_REDACTED' } }, blocked: true };
  }
  return { send: null, blocked: true };
}

/** Installs the redactor on a transport (in place). Returns the same transport. */
export function guardTransport<T extends { send: (message: never, options?: never) => Promise<void> }>(
  transport: T,
  matcher: FrameMatcher,
  log: RedactLog,
): T {
  const original = transport.send.bind(transport) as (m: unknown, o?: unknown) => Promise<void>;
  const guarded = async (message: unknown, options?: unknown): Promise<void> => {
    const m = message as JsonRpcLike;
    const r = redactFrame(m, matcher);
    if (r.blocked) {
      log('LOCAL_REDACTED', {
        kind: m.method === undefined ? 'response' : m.id === undefined ? 'notification' : 'request',
        ...(typeof m.method === 'string' ? { method: m.method } : {}),
      });
    }
    if (r.send === null) return;
    return original(r.send, options);
  };
  (transport as { send: unknown }).send = guarded;
  return transport;
}

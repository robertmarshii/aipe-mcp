// Elicitation port (plan §3.4) over the v2 MCP SDK, for both protocol eras:
//   - 2025-era connections: a real elicitation/create request with our own 90 s timeout; a
//     timeout or a client that never answers is "timeout" (LOCAL_NO_HUMAN_ANSWER, not a no);
//   - 2026-07-28 requests: the handler returns an input_required result; the client asks the
//     human and calls the tool again with the answer in inputResponses. Answers from earlier
//     rounds travel in requestState, HMAC-bound to this server process, the tool and its exact
//     arguments, so a client cannot forge or replay them for another call.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CLIENT_CAPABILITIES_META_KEY, inputRequired, type McpServer, type ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { ELICIT_TIMEOUT_MS, type ElicitOutcome, type ElicitPort } from './confirm.ts';

const ConfirmSchema = z.object({ confirm: z.boolean().describe('Approve') });
const CONFIRM_JSON: { type: 'object'; properties: Record<string, { type: 'boolean'; title: string; description: string }>; required: string[] } = {
  type: 'object',
  properties: { confirm: { type: 'boolean', title: 'Approve', description: 'Approve this action' } },
  required: ['confirm'],
};
const OUTCOMES: readonly ElicitOutcome[] = ['accept', 'decline', 'cancel', 'timeout'];

function supportsForm(caps: unknown): boolean {
  const e = (caps as { elicitation?: unknown } | undefined)?.elicitation;
  if (e === undefined || e === null || typeof e !== 'object') return false;
  const keys = Object.keys(e);
  // a bare {} means form mode only (2025-06-18); otherwise form must be listed
  return keys.length === 0 || keys.includes('form');
}

/** Maps a raw elicitation answer (any shape: 2026 inputResponses are untrusted) to an outcome. */
export function outcomeOf(r: { action?: unknown; content?: unknown } | undefined): ElicitOutcome {
  if (r === undefined || r === null) return 'timeout';
  if (r.action === 'accept') return (r.content as { confirm?: unknown } | undefined)?.confirm === true ? 'accept' : 'decline';
  if (r.action === 'decline') return 'decline';
  if (r.action === 'cancel') return 'cancel';
  return 'timeout';
}

export const ROUND_TTL_MS = 10 * 60 * 1000;

export interface StateSeal {
  secret: Buffer;
  /** tool name + canonical arguments of this call */
  binding: string;
  /** nonces of rounds already used, with their expiry (ms); shared by the whole process */
  spent: Map<string, number>;
  now: () => number;
}

/** What a sealed round carries: earlier answers, the keys asked in it, a nonce and an expiry. */
export interface Round {
  a: Record<string, ElicitOutcome>;
  k: string[];
  n: string;
  e: number;
}

function mac(seal: StateSeal, body: string): string {
  return createHmac('sha256', seal.secret).update(`${seal.binding}\n${body}`).digest('base64url');
}

export function sealState(seal: StateSeal, round: Round): string {
  const body = Buffer.from(JSON.stringify(round)).toString('base64url');
  return `${body}.${mac(seal, body)}`;
}

function isRound(v: unknown): v is Round {
  const r = v as Round | null;
  return (
    r !== null &&
    typeof r === 'object' &&
    typeof r.n === 'string' &&
    typeof r.e === 'number' &&
    Array.isArray(r.k) &&
    r.k.every((k) => typeof k === 'string') &&
    r.a !== null &&
    typeof r.a === 'object' &&
    Object.values(r.a).every((o) => OUTCOMES.includes(o))
  );
}

/** The sealed round, or null when it is missing, forged, for another call, or expired. */
export function openState(seal: StateSeal, state: unknown): Round | null {
  if (typeof state !== 'string') return null;
  const [body, tag, extra] = state.split('.');
  if (body === undefined || tag === undefined || extra !== undefined) return null;
  const want = Buffer.from(mac(seal, body));
  const got = Buffer.from(tag);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!isRound(parsed) || parsed.e <= seal.now()) return null;
  return parsed;
}

/**
 * Takes the round's answers once: the nonce is spent (a replayed requestState is ignored), and
 * only answers to the keys that round asked are accepted. Anything else (an unsolicited
 * inputResponses on a first call, a forged or replayed state) gives no answers, so the human is
 * asked again.
 */
export function takeRound(seal: StateSeal, state: unknown, responses: Record<string, unknown> | undefined): Record<string, ElicitOutcome> {
  const now = seal.now();
  for (const [n, exp] of seal.spent) if (exp <= now) seal.spent.delete(n);
  const r = openState(seal, state);
  if (r === null || seal.spent.has(r.n)) return {};
  seal.spent.set(r.n, r.e);
  const answers = { ...r.a };
  for (const k of r.k) {
    const v = responses?.[k];
    if (v !== undefined) answers[k] = outcomeOf(v as { action?: unknown; content?: unknown });
  }
  return answers;
}

export function makeElicitPort(server: McpServer, ctx: ServerContext, seal: StateSeal, timeoutMs = ELICIT_TIMEOUT_MS): ElicitPort {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const modern = envelope !== undefined;
  const caps = modern ? envelope[CLIENT_CAPABILITIES_META_KEY] : server.server.getClientCapabilities();
  let answers: Record<string, ElicitOutcome> | undefined;
  return {
    canElicit: supportsForm(caps),
    async ask(key: string, message: string) {
      if (modern) {
        answers ??= takeRound(seal, ctx.mcpReq.requestState(), ctx.mcpReq.inputResponses);
        const known = answers[key];
        if (known !== undefined) return known;
        const round: Round = { a: answers, k: [key], n: randomBytes(16).toString('base64url'), e: seal.now() + ROUND_TTL_MS };
        return {
          defer: inputRequired({
            inputRequests: { [key]: inputRequired.elicit({ message, requestedSchema: ConfirmSchema }) },
            requestState: sealState(seal, round),
          }),
        };
      }
      try {
        const r = await ctx.mcpReq.elicitInput({ mode: 'form', message, requestedSchema: CONFIRM_JSON }, { timeout: timeoutMs });
        return outcomeOf(r as { action?: unknown; content?: unknown });
      } catch {
        return 'timeout';
      }
    },
  };
}

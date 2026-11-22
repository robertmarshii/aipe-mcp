// Sandbox adapter (plan §2.3): runs the SDK's runSandbox in the background and pauses it whenever
// the model must answer (a reasoning challenge, the rules, a guard challenge). The tool call that
// meets a pause returns needs_input; aipe_answer resumes it.
//
// - Host guard: every practice move (fixture decision) asserts the client is the sandbox client
//   on the public sandbox (or the configured test URL); otherwise LOCAL_FIXTURE_REFUSED.
// - Pending challenge first: before each (re)start an open guard challenge is answered first, so
//   the resumed run never meets CHALLENGE_PENDING.
// - Reasoning answers are checked in the callback (the adapter calls answerReasoning itself and
//   asks again on `incorrect`); the runner's own call then replays an already-passed id, which
//   the sandbox answers with the stored result (verified in api/src/sandbox/routes/identity.ts).
// - Guard challenges and rules are answered by the runner; a wrong answer ends the run with that
//   error, and the adapter restarts it (pending-first; the runner re-prepares the rules) with
//   last_result. Guard answers are never sent twice: the sandbox does not replay those.
// - The sandbox state (step token) is saved after every pause and at the end, so a killed server
//   resumes the same run.
import { randomBytes } from 'node:crypto';
import { AipeError, canonicalPolicyText, ChallengeRequired, DEFAULT_BASE_URLS, type AipeClient, type SandboxDecisions } from 'aipe-sdk';
import { adviceFor } from '../content/advice.ts';
import { challengeShape } from '../runtime/challenges.ts';
import { LocalFailure, normaliseError, type ErrorResult } from '../runtime/errors.ts';
import type { Runtime } from '../runtime/runtime.ts';
import { sanitiseString } from '../runtime/sanitise.ts';
import { numberedWords } from '../runtime/words.ts';

export type InputKind = 'reasoning' | 'rules' | 'gate_challenge';
export const PAUSE_GRACE_MS = 5_000;
export const RULES_WINDOW_MS = 10 * 60 * 1000;
export const MAX_RESTARTS = 12;

export interface Pause {
  input_id: string;
  kind: InputKind;
  view: Record<string, unknown>;
  expires_at: string;
  last_result?: Record<string, unknown>;
  resolve: (answer: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

export type SessionEvent =
  | { type: 'pause'; pause: Pause }
  | { type: 'certified'; fp: string; expires_at: string }
  | { type: 'failed'; error: ErrorResult };

/** Asserts the client may make practice moves: the sandbox environment on an allowed base URL. */
export function assertFixtureHost(client: AipeClient, baseUrl: string, allowed: readonly string[]): void {
  if (client.environment !== 'sandbox' || !allowed.includes(baseUrl)) {
    throw new LocalFailure('LOCAL_FIXTURE_REFUSED', 'practice moves are refused anywhere except the practice sandbox');
  }
}

export function allowedSandboxBases(rt: Runtime): string[] {
  const out = [DEFAULT_BASE_URLS.sandbox as string];
  if (rt.cfg.sandboxUrl !== undefined) out.push(rt.cfg.sandboxUrl);
  return out;
}

function isCorrectable(err: unknown): boolean {
  // Not here: INPUT_EXPIRED (an unanswered question stops the run; the next certify call resumes
  // it) and CHALLENGE_BLOCKED (the run stops and the error carries retry_at: no rapid restarts).
  return err instanceof AipeError && ['CHALLENGE_WRONG', 'CHALLENGE_EXPIRED', 'SCHEMA_INVALID'].includes(err.code);
}

function lastResultOf(err: unknown): Record<string, unknown> {
  // the sandbox (like live) answers wrong rules words with SCHEMA_INVALID on word_answers
  if (err instanceof AipeError && err.code === 'SCHEMA_INVALID' && err.field === 'word_answers') {
    return { result: 'incorrect', field: 'word_answers', what_to_do: adviceFor('WORDS_WRONG') };
  }
  if (err instanceof AipeError) {
    const left = err.extra?.attempts_left;
    return { result: err.code.toLowerCase(), ...(typeof left === 'number' ? { attempts_left: left } : {}) };
  }
  return { result: 'error' };
}

const TEXT = 'Practice project for the sandbox run';

/** The canned practice fixtures (decided yes, plan §2.3), each behind the host guard. */
function fixtures(client: AipeClient, guard: () => void): Pick<SandboxDecisions, 'project' | 'listing' | 'offer' | 'acceptOffer' | 'declareDone' | 'review' | 'securityAssessment'> {
  let offered = false;
  return {
    securityAssessment: async () => {
      guard();
      return { tools_with_external_access: [], handles_untrusted_input: true, human_approval_for_actions: 'always', can_post_publicly: false, stores_credentials: false };
    },
    project: async () => {
      guard();
      return { kind: 'domain', identity: 'my-project.example.org', name: TEXT, summary: TEXT, audience: TEXT, description: TEXT, language: 'en', goals: TEXT, category: 'games', revenue_model: 'ads', ugc: false, socials: [], example_urls: [], keywords: ['gaming'], restricted_declaration: true } as never;
    },
    listing: async (n) => {
      guard();
      return { title: `Sandbox practice listing ${n}`, summary: TEXT, request: TEXT, target_urls: ['https://my-project.example.org/post'], keywords: ['gaming'], language: 'en' } as never;
    },
    // copied from sdk/e2e/decide.ts: the first OPEN own listing, once
    offer: async (listing) => {
      guard();
      if (offered) return null;
      const mine = await client.listMyListings();
      const source = mine.items.find((l) => l.status === 'OPEN');
      if (source === undefined) return null;
      offered = true;
      return { source_listing_id: source.id, target_listing_id: listing.id };
    },
    acceptOffer: async () => {
      guard();
      return true;
    },
    declareDone: async () => {
      guard();
      return true;
    },
    review: async (p) => {
      guard();
      return { reviews: p.items.filter((i) => i.reviewable && !i.reviewed).map((i) => ({ commitment_id: i.commitment_id, fulfilled: true })) };
    },
  };
}

export class SandboxSession {
  readonly #rt: Runtime;
  readonly #client: AipeClient;
  readonly #baseUrl: string;
  readonly #agentName: string;
  #pause: Pause | null = null;
  #ended: SessionEvent | null = null;
  #listeners: ((e: SessionEvent) => void)[] = [];
  #lastResult: Record<string, unknown> | undefined;
  #agentId: string | undefined;
  running = false;

  constructor(rt: Runtime, client: AipeClient, baseUrl: string, agentName: string) {
    this.#rt = rt;
    this.#client = client;
    this.#baseUrl = baseUrl;
    this.#agentName = agentName;
  }

  get agentName(): string {
    return this.#agentName;
  }

  get pause(): Pause | null {
    return this.#pause;
  }

  get ended(): SessionEvent | null {
    return this.#ended;
  }

  #emit(e: SessionEvent): void {
    const ls = this.#listeners;
    this.#listeners = [];
    for (const l of ls) l(e);
  }

  /** The next event, or null after maxMs (the run is still working). */
  next(maxMs: number): Promise<SessionEvent | null> {
    if (this.#pause !== null) return Promise.resolve({ type: 'pause', pause: this.#pause });
    if (this.#ended !== null) return Promise.resolve(this.#ended);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#listeners = this.#listeners.filter((l) => l !== on);
        resolve(null);
      }, maxMs);
      const on = (e: SessionEvent) => {
        clearTimeout(timer);
        resolve(e);
      };
      this.#listeners.push(on);
    });
  }

  async #save(): Promise<void> {
    const st = this.#client.sandboxState();
    await this.#rt.state.update((s) => {
      s.sandbox = st;
    });
  }

  /** Pauses the run until aipe_answer resolves it (or it expires). */
  async #ask(kind: InputKind, view: Record<string, unknown>, windowMs: number): Promise<Record<string, unknown>> {
    const nowMs = this.#rt.now();
    const viewExpiry = typeof view.expires_at === 'string' ? Date.parse(view.expires_at) : NaN;
    let expiresMs = Number.isFinite(viewExpiry) ? viewExpiry : nowMs + windowMs;
    const cap = this.#rt.cfg.testPauseMs; // test only (AIPE_ENV=test)
    if (cap !== undefined) expiresMs = Math.min(expiresMs, nowMs + cap);
    const input_id = `inp_${randomBytes(16).toString('hex')}`;
    await this.#save();
    await this.#rt.state.update((s) => {
      s.pending[input_id] = { kind: 'sandbox', tool: 'aipe_sandbox_certify', expires_at: new Date(expiresMs).toISOString(), at: nowMs };
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pause = null;
        reject(new AipeError({ status: 0, code: 'INPUT_EXPIRED', retryable: true, message: 'the question timed out' }));
      }, Math.max(0, expiresMs - nowMs) + PAUSE_GRACE_MS);
      const pause: Pause = {
        input_id,
        kind,
        view,
        expires_at: new Date(expiresMs).toISOString(),
        ...(this.#lastResult === undefined ? {} : { last_result: this.#lastResult }),
        resolve: (a) => {
          clearTimeout(timer);
          this.#pause = null;
          resolve(a);
        },
        reject: (e) => {
          clearTimeout(timer);
          this.#pause = null;
          reject(e);
        },
      };
      this.#pause = pause;
      this.#emit({ type: 'pause', pause });
    });
  }

  #guard = (): void => assertFixtureHost(this.#client, this.#baseUrl, allowedSandboxBases(this.#rt));

  async #agent(): Promise<string> {
    this.#agentId ??= (await this.#client.getMe()).agent_id;
    return this.#agentId;
  }

  #decide(): SandboxDecisions {
    return {
      agentName: async () => this.#agentName,
      answerReasoning: async (c) => {
        const id = String((c as { challenge_id?: string }).challenge_id ?? '');
        for (;;) {
          const view = {
            challenge_id: id,
            prompt: sanitiseString(String(c.prompt ?? ''), 8000).text,
            answer_schema: c.answer_schema ?? {},
            ...(typeof c.expires_at === 'string' ? { expires_at: c.expires_at } : {}),
          };
          const a = await this.#ask('reasoning', view, 120_000);
          const answer = (a.answer ?? {}) as Record<string, unknown>;
          const r = await this.#client.answerReasoning({ id: await this.#agent() }, { challenge_id: id, answer });
          if (r.result === 'passed') {
            this.#lastResult = undefined;
            return answer; // the runner replays it; the sandbox returns the stored result
          }
          this.#lastResult = { result: r.result, ...(r.attempts_left === undefined ? {} : { attempts_left: r.attempts_left }) };
          if (r.result === 'failed') throw new AipeError({ status: 0, code: 'CHALLENGE_BLOCKED', retryable: true, message: 'reasoning failed' });
        }
      },
      acceptRules: async (prepared) => {
        const view = {
          rules_text: canonicalPolicyText(prepared.rules as never),
          questions: prepared.positions.map((position, i) => ({ rule: i + 1, position })),
          numbered_words: numberedWords(prepared.rules),
          expires_at: prepared.expires_at,
        };
        const a = await this.#ask('rules', view, RULES_WINDOW_MS);
        this.#lastResult = undefined;
        return { acceptedRules: (a.accepted_rules ?? []) as number[], wordAnswers: (a.word_answers ?? {}) as Record<string, string> };
      },
      answerChallenge: async (err: ChallengeRequired) => {
        const view = challengeShape({ id: err.challenge.id, prompt: err.challenge.prompt, answer_schema: err.challenge.answerSchema, attempts_left: err.challenge.attemptsLeft, expires_at: err.challenge.expiresAt }, this.#rt.now());
        const a = await this.#ask('gate_challenge', view as unknown as Record<string, unknown>, 120_000);
        this.#lastResult = undefined;
        return (a.answer ?? {}) as Record<string, unknown>;
      },
      ...fixtures(this.#client, this.#guard),
    };
  }

  /** Answers an open guard challenge before the runner (re)starts. */
  async #pendingFirst(): Promise<void> {
    if (this.#client.sandboxStepToken() === null) return;
    let pending;
    try {
      pending = await this.#client.getPendingChallenge();
    } catch (err) {
      // only "not registered yet" (the key is unknown to the sandbox) means nothing can be pending;
      // anything else (network, server) surfaces
      if (err instanceof AipeError && err.status === 401) return;
      throw err;
    }
    const c = pending.challenge;
    if (c === null) return;
    for (;;) {
      const view = challengeShape(c, this.#rt.now());
      const a = await this.#ask('gate_challenge', view as unknown as Record<string, unknown>, 120_000);
      try {
        await this.#client.answerChallenge({ id: c.id }, { answer: (a.answer ?? {}) as Record<string, unknown> });
        this.#lastResult = undefined;
        return;
      } catch (err) {
        if (!(err instanceof AipeError) || err.code !== 'CHALLENGE_WRONG') throw err;
        this.#lastResult = lastResultOf(err);
      }
    }
  }

  /** Runs to a certificate, restarting after a wrong answer; ends with certified or failed. */
  async run(): Promise<void> {
    this.running = true;
    try {
      this.#guard();
      for (let i = 0; ; i += 1) {
        try {
          await this.#pendingFirst();
          // The sandbox never echoes the agent name (GET /agents/me gives a placeholder), so a
          // resumed run would sign the rules with the wrong name: the runner sees our own name.
          const name = this.#agentName;
          const target = this.#client;
          const view = new Proxy(target, {
            get(t, p) {
              if (p === 'getMe') return async (...a: Parameters<AipeClient['getMe']>) => ({ ...(await t.getMe(...a)), name });
              const v = Reflect.get(t, p, t) as unknown;
              return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
            },
          });
          const { certificate } = await target.runSandbox.call(view, this.#decide());
          await this.#save();
          const claims = JSON.parse(Buffer.from(certificate.split('.')[1] ?? '', 'base64url').toString('utf8')) as { fp: string; expires_at: number };
          const expires_at = new Date(claims.expires_at * 1000).toISOString();
          await this.#rt.state.update((s) => {
            s.certificate = { value: certificate, fp: claims.fp, expires_at };
          });
          this.#ended = { type: 'certified', fp: claims.fp, expires_at };
          break;
        } catch (err) {
          await this.#save().catch(() => undefined);
          if (!isCorrectable(err) || i >= MAX_RESTARTS) throw err;
          this.#lastResult = lastResultOf(err);
        }
      }
    } catch (err) {
      this.#ended = { type: 'failed', error: normaliseError(err, { nowMs: this.#rt.now() }) };
    } finally {
      this.running = false;
      this.#emit(this.#ended ?? { type: 'failed', error: normaliseError(new Error('stopped'), { nowMs: this.#rt.now() }) });
    }
  }
}

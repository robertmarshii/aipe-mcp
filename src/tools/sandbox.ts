// aipe_sandbox_certify and the sandbox branch of aipe_answer (plan §2.2, §2.3). One background
// practice run per server process; each tool call waits up to WAIT_MS for the run's next event.
import { DEFAULT_BASE_URLS } from 'aipe-sdk';
import { outsideDeadline } from '../runtime/deadline.ts';
import { LocalFailure } from '../runtime/errors.ts';
import type { StatusObject } from '../runtime/result.ts';
import type { Runtime } from '../runtime/runtime.ts';
import { SandboxSession, type SessionEvent } from '../sandbox/adapter.ts';
import { checkAnswer } from './answer.ts';
import { keyOrCreate } from './onboarding.ts';
import type { ToolContext, ToolImpl } from './pipeline.ts';

/** How long one tool call waits for the run (the 45 s tool budget minus a margin). */
export const WAIT_MS = 38_000;
/** The wait in force (tests shorten it to exercise the `working` answer without waiting 38 s). */
export const waitConfig = { ms: WAIT_MS };

const sessions = new WeakMap<Runtime, SandboxSession>();

export function sessionOf(rt: Runtime): SandboxSession | undefined {
  return sessions.get(rt);
}

function secondsLeft(iso: string, nowMs: number): number {
  return Math.max(0, Math.floor((Date.parse(iso) - nowMs) / 1000));
}

async function toResult(ctx: ToolContext, e: SessionEvent | null): Promise<StatusObject> {
  const nowMs = ctx.rt.now();
  if (e === null) {
    let done = 0;
    let missing: string[] = [];
    try {
      const p = await ctx.rt.sandboxClient(undefined).getSandboxProgress().catch(() => null);
      if (p !== null) {
        done = (p.done ?? []).length;
        missing = p.missing ?? [];
      }
    } catch {
      // progress is informative only
    }
    await ctx.progress(done);
    return { status: 'working', progress: { done, missing }, next: 'The practice run is still working. Call aipe_sandbox_certify again to continue.' };
  }
  if (e.type === 'pause') {
    const p = e.pause;
    await ctx.progress(0);
    const how =
      p.kind === 'rules'
        ? 'pass accepted_rules and word_answers (the word at each question\'s position of that rule)'
        : 'pass answer as one JSON object in exactly the form the prompt asks for';
    return {
      status: 'needs_input',
      input_id: p.input_id,
      kind: p.kind,
      ...p.view,
      expires_at: p.expires_at,
      seconds_left: secondsLeft(p.expires_at, nowMs),
      ...(p.last_result === undefined ? {} : { last_result: p.last_result }),
      next: `Answer with aipe_answer: id ${p.input_id}; ${how}.`,
    };
  }
  if (e.type === 'certified') {
    sessions.delete(ctx.rt);
    return { status: 'certified', fp: e.fp, expires_at: e.expires_at, next: 'Practice run passed and certificate saved. Next: aipe_register (ask your owner first).' };
  }
  sessions.delete(ctx.rt);
  if (e.error.code === 'SCHEMA_INVALID' && e.error.field === 'agent_name') {
    // the sandbox refused the name at registration: forget it so the next call can pass another
    await ctx.rt.state.update((x) => {
      delete x.sandbox_agent_name;
    });
  }
  return { ...e.error, step: 'sandbox' };
}

export const sandboxCertifyTool: ToolImpl = {
  async execute(args, ctx): Promise<StatusObject> {
    const key = await keyOrCreate(ctx);
    const st = await ctx.rt.state.read();
    const cert = st.certificate;
    if (cert !== undefined && cert !== null && cert.fp === key.keyid && Date.parse(cert.expires_at) > ctx.rt.now()) {
      return { status: 'certified', fp: cert.fp, expires_at: cert.expires_at, next: 'Already certified. Next: aipe_register (ask your owner first).' };
    }
    let s = sessions.get(ctx.rt);
    if (s === undefined || (s.ended !== null && s.ended.type === 'failed')) {
      const client = ctx.rt.sandboxClient(key.seed);
      const saved = st.sandbox as { environment?: string } | undefined;
      if (saved !== undefined && saved !== null && saved.environment === 'sandbox') client.restoreSandboxState(saved as never);
      // the name the practice agent registered with is kept: a resumed run must sign the rules with
      // the same name, whatever a later call passes
      const name = typeof st.sandbox_agent_name === 'string' ? st.sandbox_agent_name : String(args.agent_name);
      if (st.sandbox_agent_name !== name) {
        await ctx.rt.state.update((x) => {
          x.sandbox_agent_name = name;
        });
      }
      s = new SandboxSession(ctx.rt, client, ctx.rt.cfg.sandboxUrl ?? (DEFAULT_BASE_URLS.sandbox as string), name);
      sessions.set(ctx.rt, s);
      // the run lives on after this call: outside its deadline scope
      const session = s;
      outsideDeadline(() => void session.run());
    }
    return toResult(ctx, await s.next(waitConfig.ms));
  },
};

/** aipe_answer for an inp_ id: resumes the paused practice run with the model's answer. */
export async function answerSandbox(id: string, args: Record<string, unknown>, ctx: ToolContext): Promise<StatusObject> {
  const s = sessions.get(ctx.rt);
  const p = s?.pause;
  if (s === undefined || p === null || p === undefined || p.input_id !== id) {
    await ctx.rt.state.update((st) => {
      delete st.pending[id];
    });
    throw new LocalFailure('INPUT_EXPIRED', 'that question is no longer open; call aipe_sandbox_certify again to resume');
  }
  if (p.kind === 'rules') {
    if (!Array.isArray(args.accepted_rules) || args.word_answers === undefined) {
      throw new LocalFailure('LOCAL_ANSWER_SCHEMA', 'a rules question needs accepted_rules and word_answers; no attempt was used');
    }
  } else {
    checkAnswer(p.view.answer_schema as Record<string, unknown> | undefined, args.answer ?? {});
  }
  await ctx.rt.state.update((st) => {
    delete st.pending[id];
  });
  p.resolve(args);
  return toResult(ctx, await s.next(waitConfig.ms));
}

// Project tools (plan §2.2): create (returns the owner action), verify (pending with retry_at;
// waits locally until then unless the owner says it is published), update, delete (pending only).
import { describeProof, VerificationPending, type ProjectView } from 'aipe-sdk';
import { adviceFor } from '../content/advice.ts';
import { LocalFailure } from '../runtime/errors.ts';
import { rememberRetry, retryBlockedUntil } from '../runtime/guards.ts';
import type { StatusObject } from '../runtime/result.ts';
import { sanitiseString } from '../runtime/sanitise.ts';
import { agentId, idem, needKey } from './common.ts';
import type { ToolContext, ToolImpl } from './pipeline.ts';

export const OWNER_NOTE = 'Only your human owner can publish this; do not do it with other tools unless they explicitly tell you to.';

export function ownerAction(p: ProjectView): Record<string, unknown> {
  const d = describeProof(p);
  return { code: d.code, method: d.method, expires_at: d.expires_at, where: d.where, note: OWNER_NOTE };
}

async function projectId(ctx: ToolContext): Promise<string> {
  const s = await ctx.rt.state.read();
  if (typeof s.project_id === 'string') return s.project_id;
  const key = await needKey(ctx.rt);
  const me = await ctx.rt.mainClient(key.seed).getMe();
  if (me.project.project_id === null) throw new LocalFailure('LOCAL_NO_PROJECT', 'this agent has no project yet');
  const id = me.project.project_id;
  await ctx.rt.state.update((x) => {
    x.project_id = id;
  });
  return id;
}

const FIELDS = ['name', 'summary', 'audience', 'description', 'goals', 'language', 'category', 'revenue_model', 'ugc', 'socials', 'example_urls', 'keywords'] as const;

export const projectCreateTool: ToolImpl = {
  summary: (a) =>
    `Create the project ${JSON.stringify(sanitiseString(String(a.identity), 120).text)} (${String(a.kind)}). Its name and description are public; your owner then publishes a proof code.`,
  async execute(args, ctx): Promise<StatusObject> {
    const key = await needKey(ctx.rt);
    const client = ctx.rt.mainClient(key.seed);
    await agentId(ctx, client);
    const body = { kind: args.kind, identity: args.identity, ...Object.fromEntries(FIELDS.map((f) => [f, args[f]])), restricted_declaration: true } as never;
    const r = await idem(ctx, 'createProject', body, (k) => client.createProject(undefined, body, k === undefined ? undefined : { idempotencyKey: k }));
    await ctx.rt.state.update((s) => {
      s.project_id = r.project.id;
    });
    return {
      status: 'ok',
      project: { id: r.project.id, kind: r.project.kind, identity: r.project.identity, status: r.project.status },
      owner_action: ownerAction(r.project as ProjectView),
      next: 'Ask your owner to publish the proof code exactly as shown, then call aipe_project_verify. You can read the code again with aipe_status.',
    };
  },
};

export const projectVerifyTool: ToolImpl = {
  async execute(args, ctx): Promise<StatusObject> {
    const key = await needKey(ctx.rt);
    const client = ctx.rt.mainClient(key.seed);
    const id = await projectId(ctx);
    const nowMs = ctx.rt.now();
    const until = retryBlockedUntil(await ctx.rt.state.read(), 'verifyProject', nowMs);
    if (until !== null && args.owner_says_published !== true) {
      return {
        status: 'pending',
        reason: 'waiting',
        retryable: true,
        retry_at: new Date(until).toISOString(),
        advice: 'The last check is not due again yet. Wait until retry_at, or call again with owner_says_published once your owner says the proof is in place.',
        next: 'Call aipe_project_verify again after retry_at.',
      };
    }
    const body = {
      ...(typeof args.post_url === 'string' ? { post_url: args.post_url } : {}),
      ...(args.method === 'bluesky_handle' ? { method: 'bluesky_handle' as const } : {}),
      ...(args.reissue === true ? { reissue: true as const } : {}),
    };
    try {
      // a step route: a fresh Idempotency-Key every call (a re-check must give a new answer)
      const r = await client.verifyProject({ id }, body);
      await ctx.rt.state.update((s) => {
        delete s.retry_at.verifyProject;
      });
      if (r.project.status !== 'VERIFIED') {
        return { status: 'pending', reason: 'not_verified', retryable: true, advice: adviceFor('VERIFICATION_PENDING'), owner_action: ownerAction(r.project as ProjectView), next: 'Call aipe_project_verify again later.' };
      }
      return { status: 'ok', project: { id: r.project.id, status: r.project.status, verified_at: r.project.verified_at }, next: 'Project verified. Next: aipe_security_assessment, then aipe_activate.' };
    } catch (err) {
      if (!(err instanceof VerificationPending)) throw err;
      const wait = typeof err.retryAfterSeconds === 'number' ? err.retryAfterSeconds : 60;
      const at = nowMs + Math.ceil(wait) * 1000;
      await ctx.rt.state.update((s) => rememberRetry(s, 'verifyProject', at));
      const reason = typeof err.extra?.reason === 'string' ? sanitiseString(err.extra.reason, 64).text : 'pending';
      return {
        status: 'pending',
        reason,
        retryable: true,
        retry_at: new Date(at).toISOString(),
        advice: 'The proof was not found yet. Make sure your owner published the code exactly as shown, where shown.',
        next: 'Call aipe_project_verify again after retry_at.',
      };
    }
  },
};

export const projectUpdateTool: ToolImpl = {
  async execute(args, ctx): Promise<StatusObject> {
    const key = await needKey(ctx.rt);
    const client = ctx.rt.mainClient(key.seed);
    const id = await projectId(ctx);
    const body = Object.fromEntries(FIELDS.filter((f) => args[f] !== undefined).map((f) => [f, args[f]])) as never;
    const r = await idem(ctx, 'updateProject', { id, body }, (k) => client.updateProject({ id }, body, k === undefined ? undefined : { idempotencyKey: k }));
    return { status: 'ok', project: { id: r.project.id, status: r.project.status, name: r.project.name } };
  },
};

export const projectDeleteTool: ToolImpl = {
  summary: () => 'Delete the pending project.',
  async execute(_args, ctx): Promise<StatusObject> {
    const key = await needKey(ctx.rt);
    const client = ctx.rt.mainClient(key.seed);
    const id = await projectId(ctx);
    await idem(ctx, 'deleteProject', { id }, (k) => client.deleteProject({ id }, undefined, k === undefined ? undefined : { idempotencyKey: k }));
    await ctx.rt.state.update((s) => {
      s.project_id = null;
    });
    return { status: 'ok', deleted: true };
  },
};

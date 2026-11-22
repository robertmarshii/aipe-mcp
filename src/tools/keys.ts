// Key recovery tools (plan §2.2): aipe_key_recover (H) and aipe_key_recovery_cancel (H).
// Recovery is refused while the current key still authenticates. The new key is made here
// (key.next.pem, 0600) and used only after the recovery completes (maybeSwitchKey).
import { AipeError } from 'aipe-sdk';
import { LocalFailure } from '../runtime/errors.ts';
import { createKey, ensureProfileDir, exists, loadKeyChecked } from '../runtime/keystore.ts';
import type { StatusObject } from '../runtime/result.ts';
import { sanitiseString } from '../runtime/sanitise.ts';
import { guarded, keyNotAccepted, needKey } from './common.ts';
import { OWNER_NOTE } from './project.ts';
import type { ToolContext, ToolImpl } from './pipeline.ts';

/** Where a recovery code is published: the same place as the project proof, by project kind. */
const WHERE: Readonly<Record<string, Record<string, string>>> = {
  domain: { dns_txt: 'a TXT record on the domain, as for the project proof' },
  host: { well_known: 'the well-known file on the host, as for the project proof' },
  bluesky: { bluesky: 'profile_bio' },
  x: { x: 'public_post' },
  reddit: { reddit: 'post_title' },
  youtube: { youtube: 'video_title' },
};

/** true when the profile's current key still authenticates (then no recovery is allowed). */
async function currentKeyWorks(ctx: ToolContext): Promise<boolean> {
  const k = await ctx.rt.keys.current();
  if (k === null) return false;
  try {
    const me = await ctx.rt.mainClient(k.seed).getMe();
    // a key the server lists as revoked no longer counts as working
    const mine = me.keys.find((x) => x.fingerprint === k.keyid);
    return !(mine !== undefined && (mine.status === 'REVOKED' || mine.revoked_at !== null));
  } catch (err) {
    if (keyNotAccepted(err)) return false;
    // any other 401 (for example an expired signature from clock skew) does not mean the key is gone
    if (err instanceof AipeError && err.status === 401) return true;
    throw err;
  }
}

async function nextKey(ctx: ToolContext): Promise<{ seed: Uint8Array; keyid: string }> {
  const o = ctx.rt.keys.options;
  await ensureProfileDir(ctx.rt.cfg.profileDir, o);
  if (await exists(ctx.rt.cfg.nextKeyFile)) {
    const seed = await loadKeyChecked(ctx.rt.cfg.nextKeyFile, o);
    ctx.rt.keys.add(seed);
    return { seed, keyid: ctx.rt.mainClient(seed).keyid as string };
  }
  const k = await createKey(ctx.rt.cfg.nextKeyFile, o);
  ctx.rt.keys.add(k.seed);
  return k;
}

export const keyRecoverTool: ToolImpl = {
  summary: (a) =>
    `Start a key recovery for the project ${JSON.stringify(sanitiseString(String(a.identity), 120).text)} (${String(a.kind)}). A new key is made on this machine; your owner must publish a recovery code where the project proof lives.`,
  async execute(args, ctx): Promise<StatusObject> {
    if (ctx.rt.cfg.explicitKeyFile !== undefined) {
      throw new LocalFailure('LOCAL_CONFIG', 'key recovery needs a profile key, not a mounted AIPE_KEY_FILE');
    }
    if (await currentKeyWorks(ctx)) throw new LocalFailure('LOCAL_KEY_STILL_WORKS', 'the current key still authenticates');
    const next = await nextKey(ctx);
    const client = ctx.rt.mainClient(next.seed);
    const kind = String(args.kind);
    const project = { kind: kind as never, identity: String(args.identity), ...(typeof args.post_url === 'string' ? { postUrl: args.post_url } : {}) };
    // the SDK turns 202 VERIFICATION_PENDING into {pending: true}: the code is not published yet
    const r = await guarded(ctx, 'recoverKey', () => client.recoverKey({ project, newPrivateKey: next.seed }));
    if (r.pending) {
      return {
        status: 'owner_action',
        owner_action: { code: r.code, where: WHERE[kind] ?? {}, note: OWNER_NOTE },
        next: 'Ask your owner to publish the recovery code where the project proof lives, then call aipe_key_recover again with the same project.',
      };
    }
    const body = r.body as { recovery_id: string; eligible_at: string; frozen: boolean };
    await ctx.rt.state.update((s) => {
      s.recovery = { recovery_id: body.recovery_id, eligible_at: body.eligible_at, next_key_file: 'key.next.pem' };
    });
    return { status: 'ok', recovery_id: body.recovery_id, eligible_at: body.eligible_at, frozen: body.frozen };
  },
};

export const keyRecoveryCancelTool: ToolImpl = {
  summary: (a) => `Cancel the key recovery ${String(a.recovery_id)}, which your owner did not ask for.`,
  async execute(args, ctx): Promise<StatusObject> {
    const key = await needKey(ctx.rt);
    const client = ctx.rt.mainClient(key.seed);
    const id = String(args.recovery_id);
    const r = await guarded(ctx, 'cancelRecovery', () => client.cancelRecovery({ id }));
    return { status: 'ok', recovery_id: r.recovery_id, cancelled_at: r.cancelled_at };
  },
};

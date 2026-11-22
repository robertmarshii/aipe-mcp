// Configuration from the environment (plan §1.4). Invalid settings fail at start with
// LOCAL_CONFIG; the message names the variable, never a key or a path.
import { join } from 'node:path';
import { TOOLS, type Toolset } from '../contract/tools.ts';
import { LocalFailure } from './errors.ts';
import { KEY_FILE, NEXT_KEY_FILE, OLD_KEY_FILE, STATE_FILE, profileRoot, type PathEnv } from './keystore.ts';

export type AipeEnv = 'live' | 'sandbox' | 'staging' | 'test';
export type ConfirmLevelSetting = 'strict' | 'standard' | 'off';
export type ConfirmVia = 'auto' | 'elicit' | 'token';
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface Config {
  env: AipeEnv;
  profile: string;
  root: string;
  profileDir: string;
  keyFile: string;
  nextKeyFile: string;
  oldKeyFile: string;
  /** set when AIPE_KEY_FILE names a key outside the profile folder */
  explicitKeyFile: string | undefined;
  stateFile: string;
  trustPerms: boolean;
  confirm: ConfirmLevelSetting;
  /** DEC26: who approves aipe_offer_accept: the agent alone (default) or the owner (H tool); strict means owner */
  confirmAccept: 'agent' | 'owner';
  confirmVia: ConfirmVia;
  /** staging/test only */
  baseUrl: string | undefined;
  /** test only: the sandbox base URL for the second client (local stacks) */
  sandboxUrl: string | undefined;
  toolset: Toolset;
  /** test only (AIPE_ENV=test): a file holding the local stack's clock offset in ms */
  testClockFile: string | undefined;
  /** test only (AIPE_ENV=test): cap on how long a practice-run question stays open, in ms */
  testPauseMs: number | undefined;
  /** test only: allowlist of tool names */
  tools: ReadonlySet<string> | undefined;
  log: LogLevel;
  platform: NodeJS.Platform;
}

function bad(variable: string, why: string): never {
  throw new LocalFailure('LOCAL_CONFIG', `${variable}: ${why}`);
}

function oneOf<T extends string>(variable: string, value: string | undefined, allowed: readonly T[], dflt: T): T {
  if (value === undefined || value === '') return dflt;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  return bad(variable, `must be one of ${allowed.join(', ')}`);
}

/** Paths in our own secret area on this server must never be used by the MCP server. */
function refuseSecretArea(variable: string, path: string): void {
  if (/(^|[\\/])\.(?:aipe|aape)-/.test(path)) bad(variable, 'must not point into a .aipe-* or .aape-* folder');
}

function checkBaseUrl(variable: string, raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return bad(variable, 'is not a URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') bad(variable, 'must be http(s)');
  if (!u.pathname.replace(/\/+$/, '').endsWith('/v1')) bad(variable, "must end in '/v1'");
  return raw.replace(/\/+$/, '');
}

export function loadConfig(p: PathEnv): Config {
  const e = p.env;
  const env = oneOf<AipeEnv>('AIPE_ENV', e.AIPE_ENV, ['live', 'sandbox', 'staging', 'test'], 'live');
  const profile = e.AIPE_PROFILE === undefined || e.AIPE_PROFILE === '' ? 'default' : e.AIPE_PROFILE;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile)) bad('AIPE_PROFILE', 'use 1-64 lower-case letters, digits, - or _');
  const root = profileRoot(p);
  refuseSecretArea('AIPE_HOME', root);
  const profileDir = join(root, profile);
  const keyEnv = e.AIPE_KEY_FILE;
  const explicitKeyFile = keyEnv === undefined || keyEnv === '' ? undefined : keyEnv;
  if (explicitKeyFile !== undefined) refuseSecretArea('AIPE_KEY_FILE', explicitKeyFile);
  const perms = e.AIPE_KEY_PERMS;
  if (perms !== undefined && perms !== '' && perms !== 'trust') bad('AIPE_KEY_PERMS', "only 'trust' is allowed");

  let baseUrl: string | undefined;
  const rawBase = e.AIPE_BASE_URL;
  if (rawBase !== undefined && rawBase !== '') {
    if (env === 'live' || env === 'sandbox') bad('AIPE_BASE_URL', 'is refused for live and sandbox');
    baseUrl = checkBaseUrl('AIPE_BASE_URL', rawBase);
  } else if (env === 'staging' || env === 'test') {
    bad('AIPE_BASE_URL', `is required for ${env}`);
  }
  let sandboxUrl: string | undefined;
  const rawSandbox = e.AIPE_SANDBOX_URL;
  if (rawSandbox !== undefined && rawSandbox !== '') {
    if (env === 'live' || env === 'sandbox') bad('AIPE_SANDBOX_URL', 'is refused for live and sandbox');
    sandboxUrl = checkBaseUrl('AIPE_SANDBOX_URL', rawSandbox);
  }

  let testClockFile: string | undefined;
  const rawClock = e.AIPE_TEST_CLOCK_FILE;
  if (rawClock !== undefined && rawClock !== '') {
    if (env !== 'test') bad('AIPE_TEST_CLOCK_FILE', 'is only allowed with AIPE_ENV=test');
    testClockFile = rawClock;
  }

  let testPauseMs: number | undefined;
  const rawPause = e.AIPE_TEST_PAUSE_MS;
  if (rawPause !== undefined && rawPause !== '') {
    if (env !== 'test') bad('AIPE_TEST_PAUSE_MS', 'is only allowed with AIPE_ENV=test');
    testPauseMs = Number(rawPause);
    if (!Number.isSafeInteger(testPauseMs) || testPauseMs < 100) bad('AIPE_TEST_PAUSE_MS', 'must be an integer of at least 100');
  }

  let tools: Set<string> | undefined;
  const rawTools = e.AIPE_TOOLS;
  if (rawTools !== undefined && rawTools !== '') {
    tools = new Set(rawTools.split(',').map((s) => s.trim()).filter((s) => s !== ''));
    for (const t of tools) if (!TOOLS.some((x) => x.name === t)) bad('AIPE_TOOLS', `unknown tool ${t.slice(0, 40)}`);
  }

  return {
    env,
    profile,
    root,
    profileDir,
    keyFile: explicitKeyFile ?? join(profileDir, KEY_FILE),
    nextKeyFile: join(profileDir, NEXT_KEY_FILE),
    oldKeyFile: join(profileDir, OLD_KEY_FILE),
    explicitKeyFile,
    stateFile: join(profileDir, STATE_FILE),
    trustPerms: perms === 'trust',
    confirm: oneOf<ConfirmLevelSetting>('AIPE_CONFIRM', e.AIPE_CONFIRM, ['strict', 'standard', 'off'], 'standard'),
    // AIPE_CONFIRM=strict implies owner approval for accepting offers (review of #74)
    // (the value is checked first, so an invalid one is refused even under strict)
    confirmAccept: ((v) => (e.AIPE_CONFIRM === 'strict' ? 'owner' : v))(oneOf<'agent' | 'owner'>('AIPE_CONFIRM_ACCEPT', e.AIPE_CONFIRM_ACCEPT, ['agent', 'owner'], 'agent')),
    confirmVia: oneOf<ConfirmVia>('AIPE_CONFIRM_VIA', e.AIPE_CONFIRM_VIA, ['auto', 'elicit', 'token'], 'auto'),
    baseUrl,
    sandboxUrl,
    testClockFile,
    testPauseMs,
    toolset: oneOf<Toolset>('AIPE_TOOLSET', e.AIPE_TOOLSET, ['onboarding', 'trading', 'all'], 'all'),
    tools,
    log: oneOf<LogLevel>('AIPE_LOG', e.AIPE_LOG, ['error', 'warn', 'info', 'debug'], 'warn'),
    platform: p.platform,
  };
}

// aipe-mcp entry point: a local stdio MCP server. Every outgoing JSON-RPC frame passes the
// fail-closed redactor before it reaches stdout; stdout carries frames and nothing else.
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './runtime/config.ts';
import { LocalFailure } from './runtime/errors.ts';
import { defaultPathEnv } from './runtime/keystore.ts';
import { makeLogger, routeConsoleToStderr } from './runtime/log.ts';
import { FrameMatcher, guardTransport } from './runtime/redact.ts';
import { makeRuntime } from './runtime/runtime.ts';
import { createAipeServer } from './server.ts';
import { maybeSwitchKey } from './tools/common.ts';

async function main(): Promise<void> {
  routeConsoleToStderr();
  let cfg;
  try {
    cfg = loadConfig(defaultPathEnv());
  } catch (err) {
    const msg = err instanceof LocalFailure ? `${err.code} ${err.message}` : 'LOCAL_CONFIG invalid settings';
    process.stderr.write(`aipe-mcp error ${msg}\n`);
    process.exit(2);
  }
  // the donation wallet key now lives only inside cfg.donationWallet: no dependency can read it
  delete process.env.AIPE_DONATION_WALLET_KEY;
  const log = makeLogger(cfg.log);
  const rt = makeRuntime(cfg, log);
  await rt.keys.refresh();
  // The redactor wraps the stdio transport's send(): every frame of either protocol era leaves
  // through it. serveStdio picks the era from the opening message (2026-07-28 via
  // server/discover, otherwise the 2025 initialize handshake) and pins one server instance.
  const wire = guardTransport(new StdioServerTransport(), new FrameMatcher(rt.keys), (code, d) =>
    log('warn', code, { kind: d.kind, method: d.method }),
  );
  serveStdio(() => createAipeServer(rt), { transport: wire, onerror: () => log('warn', 'TRANSPORT_ERROR') });
  log('info', 'STARTED', { env: cfg.env, toolset: cfg.toolset });
  // a recovery that completed while the server was stopped: switch to the new key, after the
  // transport is up, so a slow or offline service never holds up initialize
  void maybeSwitchKey(rt).catch(() => false);
}

main().catch(() => {
  process.stderr.write('aipe-mcp error LOCAL_INTERNAL start failed\n');
  process.exit(1);
});

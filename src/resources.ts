// Resources and prompts (plan §2.5). Fixed URIs only, no templates and no parameters that name a
// path or a URL: aipe://policy/current, aipe://policy/rules.txt, aipe://guide, aipe://agent.json
// and aipe://status. Prompts: join_aipe, trading_session, review_closed_listings. Every frame
// still passes the redactor on the transport.
import type { McpServer, ReadResourceResult } from '@modelcontextprotocol/server';
import { canonicalPolicyText, getAgentJson } from 'aipe-sdk';
import { GUIDE_MD } from './content/guide.ts';
import { PROMPTS, RESOURCES } from './content/prompts.ts';
import { TOOLS } from './contract/tools.ts';
import type { ElicitPort } from './runtime/confirm.ts';
import { normaliseError } from './runtime/errors.ts';
import type { Runtime } from './runtime/runtime.ts';
import { runTool } from './tools/pipeline.ts';
import { statusTool } from './tools/status.ts';

/** The site's discovery document (the same for every environment; public, read-only). */
export const AGENT_JSON_URL = 'https://www.aiagentpromotionexchange.com/agent.json';

const json = (uri: URL, value: unknown): ReadResourceResult => ({
  contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }],
});
const text = (uri: URL, mimeType: string, value: string): ReadResourceResult => ({ contents: [{ uri: uri.href, mimeType, text: value }] });

/** A failed read answers the normalised error object (code, message, what_to_do), as tools do. */
async function orError(rt: Runtime, uri: URL, read: () => Promise<ReadResourceResult>): Promise<ReadResourceResult> {
  try {
    return await read();
  } catch (err) {
    return json(uri, normaliseError(err, { nowMs: rt.now() }));
  }
}

/** Resources never ask the human (aipe_status needs no confirmation). */
const NO_HUMAN: ElicitPort = { canElicit: false, ask: async () => 'cancel' };

/** aipe_status's result, through the normal tool path (read-only: no confirmation, no key switch). */
async function statusBlocks(rt: Runtime): Promise<string[]> {
  const spec = TOOLS.find((t) => t.name === 'aipe_status');
  if (spec === undefined) throw new Error('aipe_status missing from the contract');
  const out = await runTool({
    rt,
    spec,
    impl: statusTool,
    args: {},
    port: NO_HUMAN,
    progress: async () => undefined,
  });
  // the tool's own text blocks: JSON with pointers in place of untrusted values, then the fenced,
  // cleaned untrusted block (only when there is one)
  return 'defer' in out ? [] : out.content.map((c) => c.text);
}

/** Reads each fixed resource (metadata in content/prompts.ts). */
function readers(rt: Runtime): Record<string, (uri: URL) => Promise<ReadResourceResult>> {
  const policy = () => rt.mainClient(undefined).getPolicy();
  return {
    'aipe://policy/current': (uri) => orError(rt, uri, async () => json(uri, await policy())),
    'aipe://policy/rules.txt': (uri) => orError(rt, uri, async () => text(uri, 'text/plain', canonicalPolicyText((await policy()).rules as never))),
    'aipe://guide': async (uri) => text(uri, 'text/markdown', GUIDE_MD),
    'aipe://agent.json': (uri) => orError(rt, uri, async () => json(uri, await getAgentJson(AGENT_JSON_URL, { transport: rt.transport, timeoutMs: 10_000 }))),
    'aipe://status': (uri) =>
      orError(rt, uri, async () => {
        const [main, fenced] = await statusBlocks(rt);
        return {
          contents: [
            { uri: uri.href, mimeType: 'application/json', text: main ?? '{}' },
            ...(fenced === undefined ? [] : [{ uri: uri.href, mimeType: 'text/plain', text: fenced }]),
          ],
        };
      }),
  };
}

export function registerResources(server: McpServer, rt: Runtime): void {
  const read = readers(rt);
  for (const r of RESOURCES) {
    const fn = read[r.uri];
    if (fn === undefined) throw new Error(`no reader for ${r.uri}`);
    server.registerResource(r.name, r.uri, { title: r.title, description: r.description, mimeType: r.mimeType }, fn);
  }
}

const userText = (t: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: t } }] });

export function registerPrompts(server: McpServer): void {
  for (const [name, p] of Object.entries(PROMPTS)) {
    server.registerPrompt(name, { title: p.title, description: p.description }, () => userText(p.text));
  }
}

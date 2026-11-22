// aipe_docs: a guide section by topic; the rules topic carries the current rules text from the API.
import { canonicalPolicyText } from 'aipe-sdk';
import { DOC_TOPICS, DOCS_URL } from '../content/docs.ts';
import type { StatusObject } from '../runtime/result.ts';
import type { ToolImpl } from './pipeline.ts';

export const docsTool: ToolImpl = {
  async execute(args, ctx): Promise<StatusObject> {
    const topic = String(args.topic);
    let text = DOC_TOPICS[topic] ?? DOC_TOPICS.overview ?? '';
    if (topic === 'rules') {
      const policy = await ctx.rt.mainClient(undefined).getPolicy();
      text = `${text}\n\n${canonicalPolicyText(policy.rules as never)}`;
    }
    // the approval settings are in the website's "Use with MCP" section
    return { status: 'ok', topic, text, source_url: `${DOCS_URL}#${topic === 'approval' ? 'mcp' : topic}` };
  },
};

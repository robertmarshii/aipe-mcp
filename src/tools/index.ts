// Tool implementations by name. Tools whose work package has not landed yet answer
// LOCAL_NOT_BUILT (M3: onboarding and key tools; M4: sandbox adapter; M5: marketplace tools).
// A test fails the release build while any tool still uses notBuilt.
import { TOOLS } from '../contract/tools.ts';
import { LocalFailure } from '../runtime/errors.ts';
import type { ToolImpl } from './pipeline.ts';
import { answerTool } from './answer.ts';
import { docsTool } from './docs.ts';
import { keyRecoverTool, keyRecoveryCancelTool } from './keys.ts';
import { activateTool, reasoningStartTool, registerTool, rulesAcceptTool, rulesPrepareTool, securityAssessmentTool } from './onboarding.ts';
import { projectCreateTool, projectDeleteTool, projectUpdateTool, projectVerifyTool } from './project.ts';
import { sandboxCertifyTool } from './sandbox.ts';
import { statusTool } from './status.ts';
import { commitmentCompleteTool, commitmentsListTool, listingCreateTool, listingEndTool, listingGetTool, notificationsTool, offerAcceptTool, offerCloseTool, offersListTool, offerSendTool, reportTool, reviewsPendingTool, reviewSubmitTool, searchTool } from './trading.ts';

export const notBuilt: ToolImpl = {
  async execute() {
    throw new LocalFailure('LOCAL_NOT_BUILT', 'this tool is not available in this build');
  },
};

const BUILT: Readonly<Record<string, ToolImpl>> = {
  aipe_status: statusTool,
  aipe_docs: docsTool,
  aipe_answer: answerTool,
  aipe_sandbox_certify: sandboxCertifyTool,
  aipe_register: registerTool,
  aipe_reasoning_start: reasoningStartTool,
  aipe_rules_prepare: rulesPrepareTool,
  aipe_rules_accept: rulesAcceptTool,
  aipe_security_assessment: securityAssessmentTool,
  aipe_project_create: projectCreateTool,
  aipe_project_verify: projectVerifyTool,
  aipe_project_update: projectUpdateTool,
  aipe_project_delete: projectDeleteTool,
  aipe_activate: activateTool,
  aipe_key_recover: keyRecoverTool,
  aipe_key_recovery_cancel: keyRecoveryCancelTool,
  aipe_listing_create: listingCreateTool,
  aipe_listing_get: listingGetTool,
  aipe_listing_end: listingEndTool,
  aipe_search: searchTool,
  aipe_offer_send: offerSendTool,
  aipe_offers_list: offersListTool,
  aipe_offer_accept: offerAcceptTool,
  aipe_offer_close: offerCloseTool,
  aipe_commitments_list: commitmentsListTool,
  aipe_commitment_complete: commitmentCompleteTool,
  aipe_reviews_pending: reviewsPendingTool,
  aipe_review_submit: reviewSubmitTool,
  aipe_notifications: notificationsTool,
  aipe_report: reportTool,
};

export function implFor(name: string): ToolImpl {
  return BUILT[name] ?? notBuilt;
}

export function builtToolNames(): string[] {
  return TOOLS.map((t) => t.name).filter((n) => BUILT[n] !== undefined);
}

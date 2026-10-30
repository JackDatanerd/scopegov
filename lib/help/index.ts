// lib/help/index.ts
// The article registry. To publish an article: create lib/help/articles/<slug>.ts, import it here, add it to ARTICLES.
// Nothing else needs touching: the Help home page, the article route, the command palette and the tests all read from here.

import { HELP_CATEGORIES } from './categories'
import { firstProject } from './articles/first-project'
import { whyCantISendSow } from './articles/why-cant-i-send-sow'
import { pmToolFit } from './articles/pm-tool-fit'
import { workspaceSetup } from './articles/workspace-setup'
import { inviteTeamAndRoles } from './articles/invite-team-and-roles'
import { trialAndSubscribing } from './articles/trial-and-subscribing'
import { whenToWriteACo } from './articles/when-to-write-a-co'
import { createAndSendCo } from './articles/create-and-send-co'
import { clientCountersCo } from './articles/client-counters-co'
import { retainerRenewalCo } from './articles/retainer-renewal-co'
import { cantCreateCoClosedProject } from './articles/cant-create-co-closed-project'
import { addingAClient } from './articles/adding-a-client'
import { fixedFeeOrRetainer } from './articles/fixed-fee-or-retainer'
import { editProjectBeforeAndAfterSow } from './articles/edit-project-before-and-after-sow'
import { completeArchiveReopenProject } from './articles/complete-archive-reopen-project'
import { assignTeamMembers } from './articles/assign-team-members'
import { whatGuardianDoes } from './articles/what-guardian-does'
import { checkClientMessageVerdict } from './articles/check-client-message-verdict'
import { understandFlagStatuses } from './articles/understand-flag-statuses'
import { forwardClientEmailsToGuardian } from './articles/forward-client-emails-to-guardian'
import { guardianGoodBadInputs } from './articles/guardian-good-bad-inputs'
import { flagToChangeOrder } from './articles/flag-to-change-order'
import { permissionsDecoder } from './articles/permissions-decoder'
import { writeASowAiOrManual } from './articles/write-a-sow-ai-or-manual'
import { sowWordingTermsExclusionsPayment } from './articles/sow-wording-terms-exclusions-payment'
import { reviewSowBeforeSending } from './articles/review-sow-before-sending'
import { whatYourClientSeesSow } from './articles/what-your-client-sees-sow'
import { clientChangesDeclineOrSilenceSow } from './articles/client-changes-decline-or-silence-sow'
import { withdrawReviseResendSow } from './articles/withdraw-revise-resend-sow'
import { createAnInvoice } from './articles/create-an-invoice'
import { paymentsAndOverContract } from './articles/payments-and-over-contract'
import { taxInclusiveOrExclusive } from './articles/tax-inclusive-or-exclusive'
import { invoiceStatuses } from './articles/invoice-statuses'
import { exportInvoices } from './articles/export-invoices'
import { doYouNeedApprovals } from './articles/do-you-need-approvals'
import { buildApprovalWorkflow } from './articles/build-approval-workflow'
import { approveOrRejectDocument } from './articles/approve-or-reject-document'
import { sendWaitingOnApproval } from './articles/send-waiting-on-approval'
import { defaultRoles } from './articles/default-roles'
import { customRolesAndMfa } from './articles/custom-roles-and-mfa'
import { perProjectAccess } from './articles/per-project-access'
import { removeMemberAndReassign } from './articles/remove-member-and-reassign'
import { planLimits } from './articles/plan-limits'
import { changeOrCancelPlan } from './articles/change-or-cancel-plan'
import { readOnlyWorkspace } from './articles/read-only-workspace'
import { exportBeforeYouLeave } from './articles/export-before-you-leave'
import { readYourDashboard } from './articles/read-your-dashboard'
import type { HelpArticle, HelpCategory } from './types'

export const ARTICLES: HelpArticle[] = [
  firstProject,
  pmToolFit,
  workspaceSetup,
  inviteTeamAndRoles,
  trialAndSubscribing,
  whyCantISendSow,
  writeASowAiOrManual,
  sowWordingTermsExclusionsPayment,
  reviewSowBeforeSending,
  whatYourClientSeesSow,
  clientChangesDeclineOrSilenceSow,
  withdrawReviseResendSow,
  whenToWriteACo,
  createAndSendCo,
  clientCountersCo,
  retainerRenewalCo,
  cantCreateCoClosedProject,
  addingAClient,
  fixedFeeOrRetainer,
  editProjectBeforeAndAfterSow,
  completeArchiveReopenProject,
  assignTeamMembers,
  whatGuardianDoes,
  checkClientMessageVerdict,
  understandFlagStatuses,
  forwardClientEmailsToGuardian,
  guardianGoodBadInputs,
  flagToChangeOrder,
  permissionsDecoder,
  createAnInvoice,
  paymentsAndOverContract,
  taxInclusiveOrExclusive,
  invoiceStatuses,
  exportInvoices,
  doYouNeedApprovals,
  buildApprovalWorkflow,
  approveOrRejectDocument,
  sendWaitingOnApproval,
  defaultRoles,
  customRolesAndMfa,
  perProjectAccess,
  removeMemberAndReassign,
  planLimits,
  changeOrCancelPlan,
  readOnlyWorkspace,
  exportBeforeYouLeave,
  readYourDashboard,
]

export function getArticle(slug: string): HelpArticle | null {
  return ARTICLES.find(a => a.slug === slug) ?? null
}

export function getCategory(id: string): HelpCategory | null {
  return HELP_CATEGORIES.find(c => c.id === id) ?? null
}

/** Categories that have at least one article, in display order, each with its articles sorted by `order`. */
export function groupedArticles(): Array<{ category: HelpCategory; articles: HelpArticle[] }> {
  return HELP_CATEGORIES
    .map(category => ({
      category,
      articles: ARTICLES.filter(a => a.category === category.id).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)),
    }))
    .filter(g => g.articles.length > 0)
}

export function relatedArticles(article: HelpArticle): HelpArticle[] {
  return article.related.map(getArticle).filter((a): a is HelpArticle => a !== null)
}

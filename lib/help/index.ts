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
import type { HelpArticle, HelpCategory } from './types'

export const ARTICLES: HelpArticle[] = [
  firstProject,
  pmToolFit,
  workspaceSetup,
  inviteTeamAndRoles,
  trialAndSubscribing,
  whyCantISendSow,
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

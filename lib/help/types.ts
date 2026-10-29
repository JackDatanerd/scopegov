// lib/help/types.ts
//
// The shape every in-app help article follows. The shape IS the template: an article that fills these fields in is
// automatically laid out the same way as every other article (see components/help/HelpArticleView.tsx), so authors
// write content, never layout. See lib/help/AUTHORING.md for the writing rules.
//
// Inline markup allowed inside any text field (rendered by components/help/inline.tsx, never as raw HTML):
//   **Send to client**        a UI label, button or menu item, exactly as it appears on screen
//   [Projects](/projects)     a link to a page inside the app (must start with "/")
// Nothing else is interpreted.

import type { Permission } from '@/lib/supabase/types'
import type { PaidPlan } from '@/lib/billing/entitlements'

export type HelpCategoryId =
  | 'getting-started'
  | 'clients-projects'
  | 'sow'
  | 'change-orders'
  | 'invoicing'
  | 'guardian'
  | 'approvals'
  | 'team-permissions'
  | 'billing-plans'
  | 'integrations-security'

export interface HelpCategory {
  id: HelpCategoryId
  title: string
  /** One line shown under the category heading on the Help home page. */
  description: string
}

export interface HelpStep {
  title: string
  /** The instruction: what to click or fill in, using exact on-screen labels. One short paragraph. */
  body: string
  /** Optional short bullets for the fields or options inside this step. */
  details?: string[]
  /** Optional single heads-up for the step: the one thing people get wrong here. */
  watchFor?: string
  /** Rough minutes for this step; the article's title promise should roughly match the sum. */
  minutes?: number
}

export interface HelpProblem {
  /** What the person sees or says, in their words: "I can't find the Send button". */
  symptom: string
  /** Why it happens. */
  meaning: string
  /** What to do about it. */
  fix: string
}

export interface HelpArticle {
  /** URL slug: /help/<slug>. Lowercase letters, digits and hyphens. Never change one after publishing. */
  slug: string
  /** In the reader's words ("Why can't I send my SOW?"), not the feature's name. */
  title: string
  /** One sentence, shown on the Help home page and under the title. Says what the reader will be able to do. */
  summary: string
  category: HelpCategoryId
  /** Sort position inside its category (lower first). */
  order: number
  /**
   * Who can follow this article. `permissions`: what a member needs (empty = anyone). `plan`: the lowest plan that has
   * it ('all' = every plan). Shown in the strip at the top so people self-diagnose "why can't I?" before they ask.
   */
  audience: { permissions: Permission[]; plan: 'all' | PaidPlan }
  /** Two or three sentences: the whole article in miniature. */
  shortAnswer: string
  /** Things to have ready, or already done. Omit when there is nothing. */
  beforeYouStart?: string[]
  steps: HelpStep[]
  dos: string[]
  donts: string[]
  problems: HelpProblem[]
  /** What happens after the last step, so nothing feels irreversible or mysterious. */
  whatHappensNext: string[]
  /** Slugs of other published articles. */
  related: string[]
  /** ISO date (YYYY-MM-DD) the article was last checked against the product. */
  updated: string
}

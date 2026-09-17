// lib/utils/attention.ts
// §0.14 — ONE canonical predicate. Imported everywhere. Never re-derived per screen.
// BUG-050, BUG-051: status checks only. escalatedTo IS NOT NULL is NEVER a
// standalone clause here — escalation makes an already-attention-worthy item
// more prominent; it does not independently make a resolved item attention-worthy.

import type { Project } from '@/lib/supabase/types'

export interface AttentionContext {
  project: Project & {
    guardianFlags?: Array<{ status: string }>
    changeOrders?: Array<{ status: string }>
    sowDocuments?: Array<{ status: string }>
  }
  workspace?: {
    proactiveRiskAlertsEnabled?: boolean
    proactiveRiskThreshold?: number
    currency?: string
  }
}

export function isAttentionWorthy({ project, workspace }: AttentionContext): boolean {
  // 1. Stalled project
  if (project.status === 'Stalled') return true

  // 2. Any open guardian flags
  if (project.guardianFlags?.some(f => f.status === 'open')) return true

  // 3. Any actionable change orders
  // FIX (section-10 audit, feature gap — CO expiry): 'expired' added,
  // same reasoning as 'expired' in actionableSowStatuses below — a CO
  // whose signing link has died needs the agency's attention (revise and
  // resend) exactly as much as a declined or stalled one does.
  const actionableCoStatuses = ['declined', 'countered', 'stalled', 'expired']
  if (project.changeOrders?.some(co => actionableCoStatuses.includes(co.status))) return true

  // 4. Any SOW requiring attention
  // FIX (v2): 'highest version number' is wrong — the moment a client
  // requests changes, the old version is marked 'changes_requested' AND a
  // new, unsent 'draft' version is created in the same transaction. Picking
  // the highest version always landed on that fresh draft (never
  // actionable), so attention cleared instantly instead of showing at all.
  // Correct approach: ignore unsent drafts, and look at the highest version
  // that has actually been sent to the client — that's the one whose status
  // reflects whether the ball is in the client's court (changes_requested /
  // declined, needs attention) or the agency's (awaiting_signature / signed,
  // already handled).
  // FIX (section-9 audit): 'expired' was missing here — an expired SOW is
  // exactly as actionable as a declined or changes-requested one (the
  // client's link is dead; only the agency, via reopen + resend, can move
  // it forward), but in practice this rarely surfaced because sow-stall's
  // cron already flags the project 'Stalled' well before a SOW's 30-day
  // expiry (day 7 vs. day 30), which check #1 above already catches. Left
  // as a latent gap otherwise — e.g. if the stall cron ever silently
  // failed to run — this closes it properly rather than relying on a
  // second cron's side effect.
  const actionableSowStatuses = ['declined', 'changes_requested', 'expired']
  const sentSowVersions = (project.sowDocuments || []).filter((s: any) => s.status !== 'draft')
  const currentSow = sentSowVersions.length
    ? [...sentSowVersions].sort((a: any, b: any) => (b.version ?? 0) - (a.version ?? 0))[0]
    : null
  if (currentSow && actionableSowStatuses.includes(currentSow.status)) return true

  // 5. Proactive risk alert — high-value project without signed SOW
  if (
    project.status === 'Draft' || project.status === 'Intake'
  ) {
    const alertsEnabled = workspace?.proactiveRiskAlertsEnabled ?? true
    const threshold = workspace?.proactiveRiskThreshold ?? 10000
    const noSignedSow = !project.sowDocuments?.some(s => s.status === 'signed')
    // FIX (deep audit, section 7): threshold is a single, currency-less
    // number configured in Settings — it's implicitly denominated in the
    // workspace's own default currency. Comparing it directly against
    // project.contractValue regardless of that project's own currency
    // meant a project quoted in a different currency got compared against
    // a wildly mismatched number (a KES-denominated project against a
    // USD-tuned threshold, or vice versa) — flagging ordinary local-
    // currency projects as high-risk, or missing genuinely high-value
    // ones. There's no exchange-rate conversion anywhere in this codebase
    // by design, so the honest fix is to only apply this rule when we
    // know the comparison is apples-to-apples.
    const currencyMatches = !workspace?.currency || !project.currency || project.currency === workspace.currency
    if (alertsEnabled && currencyMatches && project.contractValue > threshold && noSignedSow) return true
  }

  return false
}

export function attentionReason({ project }: AttentionContext): string | null {
  if (project.status === 'Stalled') {
    return project.stallReason === 'sow_unsigned'
      ? 'SOW unsigned — project stalled'
      : 'Project manually stalled'
  }
  if (project.guardianFlags?.some(f => f.status === 'open')) {
    const count = project.guardianFlags.filter(f => f.status === 'open').length
    return `${count} open scope flag${count !== 1 ? 's' : ''}`
  }
  if (project.changeOrders?.some(co => co.status === 'declined')) return 'Change order declined'
  if (project.changeOrders?.some(co => co.status === 'countered')) return 'Counter offer received'
  if (project.changeOrders?.some(co => co.status === 'stalled')) return 'Change order stalled'
  if (project.changeOrders?.some(co => co.status === 'expired')) return 'Change order link expired — revise and resend'
  const sentSowVersions = (project.sowDocuments || []).filter((s: any) => s.status !== 'draft')
  const currentSow = sentSowVersions.length
    ? [...sentSowVersions].sort((a: any, b: any) => (b.version ?? 0) - (a.version ?? 0))[0]
    : null
  if (currentSow?.status === 'changes_requested') return 'Client requested SOW changes'
  if (currentSow?.status === 'declined') return 'Client declined SOW'
  if (currentSow?.status === 'expired') return 'SOW link expired — reopen and resend'
  return 'High-value project — no signed SOW'
}

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
  }
}

export function isAttentionWorthy({ project, workspace }: AttentionContext): boolean {
  // 1. Stalled project
  if (project.status === 'Stalled') return true

  // 2. Any open guardian flags
  if (project.guardianFlags?.some(f => f.status === 'open')) return true

  // 3. Any actionable change orders
  const actionableCoStatuses = ['declined', 'countered', 'stalled']
  if (project.changeOrders?.some(co => actionableCoStatuses.includes(co.status))) return true

  // 4. Any SOW requiring attention
  const actionableSowStatuses = ['declined', 'changes_requested']
  if (project.sowDocuments?.some(s => actionableSowStatuses.includes(s.status))) return true

  // 5. Proactive risk alert — high-value project without signed SOW
  if (
    project.status === 'Draft' || project.status === 'Intake'
  ) {
    const alertsEnabled = workspace?.proactiveRiskAlertsEnabled ?? true
    const threshold = workspace?.proactiveRiskThreshold ?? 10000
    const noSignedSow = !project.sowDocuments?.some(s => s.status === 'signed')
    if (alertsEnabled && project.contractValue > threshold && noSignedSow) return true
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
  if (project.sowDocuments?.some(s => s.status === 'changes_requested')) return 'Client requested SOW changes'
  if (project.sowDocuments?.some(s => s.status === 'declined')) return 'Client declined SOW'
  return 'High-value project — no signed SOW'
}

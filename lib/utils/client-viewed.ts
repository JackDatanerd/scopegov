// lib/utils/client-viewed.ts
//
// FEATURE (Notifications & email fix round): migration 046 added `first_viewed_at` to SOWs, change
// orders and invoices and the three portal routes dutifully stamp it — but nothing ever read it:
// no notification, no UI. "Did the client even open it?" is the first question after sending a
// document. The first view now raises an in-app notification for the people who sent it.
//
// Two safeguards the bare timestamp never had:
//  • Link scanners. Corporate mail gateways and chat/preview services GET every link in an email
//    before a human sees it, which would report "opened" within seconds of every send. Requests
//    that look like scanners neither stamp nor notify. (A UA check is heuristic — some scanners
//    spoof browsers — so the notification says "opened", not "read".)
//  • Exactly once. The stamp is a guarded UPDATE ... RETURNING; only the request that actually
//    flipped the column notifies, so two simultaneous first views can't notify twice.

import { notifyMembersWithPermission } from '@/lib/utils/notify'
import type { Permission } from '@/lib/supabase/types'

const SCANNER =
  /bot\b|bot\/|crawl|spider|slurp|preview|scanner|prefetch|headless|safelinks|proofpoint|mimecast|barracuda|symantec|trend ?micro|forcepoint|urlscan|python-requests|curl\/|wget|go-http-client|okhttp|java\/|facebookexternalhit|slack|whatsapp|telegram|discord|linkedinbot|googleimageproxy|ggpht|yahoomailproxy|microsoft office|ms-office/i

export function looksLikeLinkScanner(userAgent: string | null | undefined): boolean {
  // Every real browser sends a User-Agent; a request without one is a script.
  if (!userAgent || !userAgent.trim()) return true
  // CUBOT phones put "CUBOT" in the UA model token ("...; CUBOT KingKong 5) ..."), which the `bot\b`
  // alternative reads as a crawler — a real person opening the link on one never registered as a view.
  return SCANNER.test(userAgent.replace(/\bcubot\b/gi, ' '))
}

export type ViewedKind = 'sow' | 'co' | 'invoice'

const KIND: Record<ViewedKind, { table: string; label: string; permission: Permission }> = {
  sow:     { table: 'sow_documents',  label: 'Statement of Work', permission: 'SEND_SOW' },
  co:      { table: 'change_orders',  label: 'change order',      permission: 'SEND_CHANGE_ORDERS' },
  invoice: { table: 'invoices',       label: 'invoice',           permission: 'VIEW_FINANCIALS' },
}

export async function markFirstViewed(service: any, opts: {
  kind: ViewedKind
  id: string
  workspaceId: string
  projectId: string
  projectName: string
  clientName: string
  userAgent: string | null | undefined
}): Promise<void> {
  try {
    if (looksLikeLinkScanner(opts.userAgent)) return
    const k = KIND[opts.kind]

    const { data, error } = await service
      .from(k.table)
      .update({ first_viewed_at: new Date().toISOString() })
      .eq('id', opts.id).is('first_viewed_at', null)
      .select('id')
    if (error) { console.error(`${opts.kind} first-view tracking failed (non-fatal):`, error.message); return }
    if (!data || data.length === 0) return // someone else stamped it first

    await notifyMembersWithPermission(service, {
      workspaceId: opts.workspaceId, permission: k.permission, eventType: 'client_viewed',
      type: `${opts.kind}_viewed`,
      title: `${opts.clientName || 'The client'} opened the ${k.label}`,
      body: `First view of the ${k.label} for ${opts.projectName}.`,
      entityType: 'project', entityId: opts.projectId, projectId: opts.projectId,
    })
  } catch (e) {
    console.error(`${opts.kind} first-view tracking failed (non-fatal):`, e)
  }
}

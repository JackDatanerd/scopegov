// lib/documents/client-details-gap.ts
// Pre-send check: which client details that print on a SOW / change order are still empty.
// Used as an acknowledgeable warning (never a hard block) — see the SOW and CO send routes.

import type { LegalAddress } from '@/lib/utils/format'

function filled(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0
}

export function clientDetailsGaps(client: { billing_address?: LegalAddress | null } | null | undefined): string[] {
  const a = (client?.billing_address || null) as LegalAddress | null
  const gaps: string[] = []
  if (!a || (!filled(a.line1) && !filled(a.city) && !filled(a.postalCode) && !filled(a.country))) gaps.push('billing address')
  else if (!filled(a.line1) || !filled(a.country)) gaps.push('complete billing address (street and country)')
  return gaps
}

export async function loadClientDetailsWarning(service: any, workspaceId: string, clientId: string | null | undefined) {
  if (!clientId) return null
  const { data: client, error } = await service
    .from('clients').select('id, name, billing_address')
    .eq('id', clientId).eq('workspace_id', workspaceId).maybeSingle()
  if (error || !client) return null // never block a send because this courtesy check could not run
  const missing = clientDetailsGaps(client)
  if (missing.length === 0) return null
  return {
    clientId: client.id as string,
    clientName: (client.name as string) || 'this client',
    missing,
    editUrl: `/clients/${client.id}`,
  }
}

// ── Agency's own details ────────────────────────────────────────────────────────────────────────
// The document prints the agency's address and (SOW / change order) signature. A brand-new workspace that
// has set neither would send out a half-blank document, so warn (acknowledgeable) before the first send.

export interface AgencyDetailsInfo {
  missing: string[]
  fixes: { label: string; url: string }[]
}

export type SendDocKind = 'sow' | 'co' | 'invoice'

export function agencyDetailsGaps(ws: { legal_address?: LegalAddress | null; agency_signature_data?: string | null } | null | undefined, kind: SendDocKind): AgencyDetailsInfo | null {
  const a = (ws?.legal_address || null) as LegalAddress | null
  const missing: string[] = []
  const fixes: { label: string; url: string }[] = []
  if (!a || !filled(a.line1) || !filled(a.country)) {
    missing.push('business address')
    fixes.push({ label: 'Add business address', url: '/settings?tab=workspace' })
  }
  if (kind !== 'invoice' && !filled(ws?.agency_signature_data)) {
    missing.push('signature')
    fixes.push({ label: 'Add signature', url: '/settings?tab=branding' })
  }
  return missing.length ? { missing, fixes } : null
}

const DOC_NAME: Record<SendDocKind, string> = { sow: 'SOW', co: 'change order', invoice: 'invoice' }

export async function loadSendDetailsWarnings(service: any, workspaceId: string, clientId: string | null | undefined, kind: SendDocKind) {
  const clientDetails = await loadClientDetailsWarning(service, workspaceId, clientId)
  let agencyDetails: AgencyDetailsInfo | null = null
  const { data: ws, error } = await service
    .from('workspaces').select('legal_address, agency_signature_data').eq('id', workspaceId).maybeSingle()
  if (!error && ws) agencyDetails = agencyDetailsGaps(ws, kind)
  if (!clientDetails && !agencyDetails) return null
  const doc = DOC_NAME[kind]
  const messages: string[] = []
  if (agencyDetails) messages.push(`Your agency has no ${agencyDetails.missing.join(' or ')} on file, so the ${doc} will go out without it.`)
  if (clientDetails) messages.push(`${clientDetails.clientName} has no ${clientDetails.missing.join(' or ')} on file, so the ${doc} will go out without it.`)
  return { clientDetails, agencyDetails, messages }
}

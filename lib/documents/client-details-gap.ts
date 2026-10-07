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

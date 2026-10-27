export const runtime = 'nodejs'

import { NextResponse, type NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { isUuidString as isUuid } from '@/lib/utils/uuid'
import { requireIntegrationAdmin } from '@/lib/integrations/guard'

// Revoke (soft: the row stays so the audit trail and "last used" history survive). Idempotent.
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    if (!isUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    // Revoking is a safety action: allowed on any plan and while lapsed, so a key can always be killed.
    const auth = await requireIntegrationAdmin('api_keys', { write: false })
    if ('response' in auth) return auth.response
    const { session } = auth
    const service = createServiceClient() as any
    const { data: row, error: readErr } = await service.from('integration_api_keys')
      .select('id, name, revoked_at').eq('id', id).eq('workspace_id', session.workspaceId).maybeSingle()
    if (readErr) throw new Error(readErr.message)
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!row.revoked_at) {
      const { error } = await service.from('integration_api_keys').update({ revoked_at: new Date().toISOString() })
        .eq('id', id).eq('workspace_id', session.workspaceId).is('revoked_at', null)
      if (error) throw new Error(error.message)
      await logAudit(service, {
        workspaceId: session.workspaceId, actorId: session.id, actorEmail: session.email, actorName: session.name,
        eventType: 'workspace.api_key_revoked', entityType: 'integration_api_key', entityId: id, entityName: row.name,
      })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('API key revoke error:', err)
    return NextResponse.json({ error: 'Could not revoke the key. Please try again.' }, { status: 500 })
  }
}

export const runtime = 'nodejs'

import { NextResponse, type NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { requireStepUpForCurrentUser } from '@/lib/auth/step-up'
import { logAudit } from '@/lib/utils/audit'
import { sanitizeDisplayName } from '@/lib/utils/sanitize'
import { requireIntegrationAdmin } from '@/lib/integrations/guard'
import { MAX_API_KEYS_PER_WORKSPACE } from '@/lib/integrations/plans'
import { generateApiKey } from '@/lib/integrations/api-keys'

// Creates an API key. The key itself is returned exactly once; only its hash is stored.
export async function POST(request: NextRequest) {
  try {
    const auth = await requireIntegrationAdmin('api_keys')
    if ('response' in auth) return auth.response
    const { session } = auth
    const body = await request.json().catch(() => null) as any
    const name = sanitizeDisplayName(String(body?.name ?? '')).trim()
    if (!name || name.length > 80) return NextResponse.json({ error: 'Give the key a name (up to 80 characters).' }, { status: 400 })

    const stepUp = await requireStepUpForCurrentUser()
    if (stepUp) return stepUp

    const service = createServiceClient() as any
    const { count, error: countErr } = await service.from('integration_api_keys')
      .select('id', { count: 'exact', head: true }).eq('workspace_id', session.workspaceId).is('revoked_at', null)
    if (countErr) throw new Error(countErr.message)
    if ((count ?? 0) >= MAX_API_KEYS_PER_WORKSPACE)
      return NextResponse.json({ error: `A workspace can have up to ${MAX_API_KEYS_PER_WORKSPACE} active API keys. Revoke one first.` }, { status: 409 })

    const { key, prefix, hash } = generateApiKey()
    const { data, error } = await service.from('integration_api_keys')
      .insert({ workspace_id: session.workspaceId, name, key_prefix: prefix, key_hash: hash, created_by: session.id })
      .select('id').single()
    if (error) throw new Error(error.message)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.api_key_created', entityType: 'integration_api_key', entityId: data.id, entityName: name,
      metadata: { prefix },
    })
    return NextResponse.json({ id: data.id, key, prefix }, { status: 201 })
  } catch (err) {
    console.error('API key create error:', err)
    return NextResponse.json({ error: 'Could not create the API key. Please try again.' }, { status: 500 })
  }
}

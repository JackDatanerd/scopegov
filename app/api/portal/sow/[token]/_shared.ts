export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'
import { logAudit } from '@/lib/utils/audit'
import { getWorkspaceJwtSecret } from '@/lib/utils/workspace-secret'

async function getSowByToken(token: string, service: any) {
  const { data: revoked } = await (service as any)
    .from('revoked_tokens').select('id').eq('token', token).single()
  if (revoked) return { error: 'Link no longer active', status: 410 }

  const { data: sow } = await (service as any)
    .from('sow_documents')
    .select('id,version,status,sections,project_id,workspace_id,projects(id,name,workspaces(agency_name))')
    .eq('token', token).single()

  if (!sow) return { error: 'Not found', status: 404 }
  if (!['awaiting_signature','changes_requested'].includes(sow.status))
    return { error: 'SOW is not awaiting signature', status: 409 }

  // jwt_secret lives in workspace_secrets now, not on workspaces itself —
  // see migration 013.
  const jwtSecret = await getWorkspaceJwtSecret(service, sow.workspace_id)
  if (!jwtSecret) return { error: 'Invalid or expired link', status: 401 }
  try {
    const secret = new TextEncoder().encode(jwtSecret)
    await jwtVerify(token, secret)
  } catch {
    return { error: 'Invalid or expired link', status: 401 }
  }
  return { sow }
}

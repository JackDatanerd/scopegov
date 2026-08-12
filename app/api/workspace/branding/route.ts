import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    // FIX (audit round 1): this endpoint had no permission gate at all —
    // any workspace member, regardless of role, could overwrite the
    // agency's brand colour, logo, and — most seriously —
    // agency_signature_data, which is rendered as the agency's binding
    // signature on auto-sent SOWs/COs. Gate it behind the same
    // permission that already governs the rest of workspace settings.
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS')) {
      return NextResponse.json({ error: 'Missing permission: MANAGE_WORKSPACE_SETTINGS' }, { status: 403 })
    }

    const { brandColour, logoStoragePath, agencySignatureData } = await request.json()
    const service = createServiceClient()

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (brandColour) updates.brand_colour = brandColour
    if (logoStoragePath && typeof logoStoragePath === 'string') {
      updates.logo_storage_path = logoStoragePath
    }
    // agencySignatureData: a base64 PNG data URL, or explicitly null to clear it
    if (agencySignatureData !== undefined) {
      updates.agency_signature_data = agencySignatureData
    }

    const { error } = await (service as any)
      .from('workspaces')
      .update(updates)
      .eq('id', session.workspaceId)  // ← from session, not body

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

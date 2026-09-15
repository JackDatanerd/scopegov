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
      // FIX (deep audit, section 5): this validated against
      // `${session.id}/...` — the user's own auth id — on the theory that
      // it mirrored a storage RLS policy shape. But the actual upload route
      // (branding/logo/route.ts) writes to `${session.workspaceId}/logo.<ext>`.
      // A user's id is essentially never equal to their workspace's id, so
      // this rejected every real upload with "Invalid logoStoragePath" and
      // silently broke logo-saving entirely. Validate against the path the
      // upload route actually produces.
      const validPath = new RegExp(`^${session.workspaceId}/logo\\.[a-zA-Z0-9]+$`)
      if (!validPath.test(logoStoragePath)) {
        return NextResponse.json({ error: 'Invalid logoStoragePath' }, { status: 400 })
      }
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

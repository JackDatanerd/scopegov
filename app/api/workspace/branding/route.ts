import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { diffFields } from '@/lib/utils/audit-diff'

const SIGNATURE_MAX_CHARS = 2_000_000

/** True when the data URL's bytes actually start like the PNG/JPEG it claims to be. */
function signatureBytesMatch(dataUrl: string): boolean {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return false
  const isPng = dataUrl.startsWith('data:image/png;')
  let head: Buffer
  try { head = Buffer.from(dataUrl.slice(comma + 1, comma + 1 + 16), 'base64') } catch { return false }
  if (isPng) return head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
  return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS')) {
      return NextResponse.json({ error: 'Missing permission: MANAGE_WORKSPACE_SETTINGS' }, { status: 403 })
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }
    const { workspaceId: expectedWorkspaceId, brandColour, logoStoragePath, agencySignatureData } = body as Record<string, unknown>
    // FIX (deep audit, Onboarding round — traced multi-tab/multi-session
    // staleness risk): this route deliberately writes to session.workspaceId
    // rather than any client-supplied ID, to defeat a confused-deputy risk
    // already hardened in the resume flow — the onboarding wizard's own
    // workspaceId in the body was ignored entirely. But nothing re-checked
    // that the caller's own idea of which workspace it's editing still
    // matched the session's active workspace before writing. A second tab or
    // device that changed the session's active workspace mid-wizard
    // (discarding it, restoring an older one) could leave a stale first tab
    // silently writing branding onto whatever workspace the session fell
    // back to instead. When the caller does tell us which workspace it
    // thinks it's editing, require it to match — a visible, safe refusal
    // instead of a silent misdirected write.
    if (expectedWorkspaceId !== undefined && expectedWorkspaceId !== session.workspaceId) {
      return NextResponse.json({
        error: 'You\u2019re no longer working on that workspace. Reload the page and try again.',
      }, { status: 409 })
    }
    const service = createServiceClient() as any

    const proposed: Record<string, unknown> = {}

    if (brandColour !== undefined) {
      if (typeof brandColour !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(brandColour)) {
        return NextResponse.json({ error: 'Brand colour must be a hex colour, e.g. #1A5C3A' }, { status: 400 })
      }
      proposed.brand_colour = brandColour.toLowerCase()
    }

    if (logoStoragePath !== undefined && logoStoragePath !== null && logoStoragePath !== '') {
      // Only a logo object inside this workspace's own folder can be referenced.
      // The upload route only ever writes logo.png or logo.jpg — `jpeg` never exists as an object.
      const validPath = new RegExp(`^${session.workspaceId}/logo\\.(png|jpg)$`)
      if (typeof logoStoragePath !== 'string' || !validPath.test(logoStoragePath)) {
        return NextResponse.json({ error: 'Invalid logoStoragePath' }, { status: 400 })
      }
      // …and it has to actually be there: pointing the workspace at an object that was never
      // uploaded would break the logo on every generated PDF and email.
      const { data: existing } = await service.storage.from('logos').list(session.workspaceId, { search: logoStoragePath.split('/')[1] })
      if (!Array.isArray(existing) || !existing.some((o: any) => o.name === logoStoragePath.split('/')[1])) {
        return NextResponse.json({ error: 'That logo has not been uploaded' }, { status: 400 })
      }
      proposed.logo_storage_path = logoStoragePath
    }

    if (agencySignatureData !== undefined && agencySignatureData !== null) {
      const ok =
        typeof agencySignatureData === 'string' &&
        agencySignatureData.length <= SIGNATURE_MAX_CHARS &&
        /^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/]+=*$/.test(agencySignatureData) &&
        signatureBytesMatch(agencySignatureData)
      if (!ok) return NextResponse.json({ error: 'Invalid signature image' }, { status: 400 })
    }
    if (agencySignatureData !== undefined) proposed.agency_signature_data = agencySignatureData

    if (Object.keys(proposed).length === 0) return NextResponse.json({ ok: true, unchanged: true })

    const { data: current, error: currentErr } = await service
      .from('workspaces').select('brand_colour, logo_storage_path, agency_signature_data')
      .eq('id', session.workspaceId).single()
    if (currentErr || !current) {
      console.error('Workspace branding: could not load workspace:', currentErr)
      return NextResponse.json({ error: 'Failed to update branding' }, { status: 500 })
    }

    // The signature image itself is never written to the audit trail.
    const REDACT = ['agency_signature_data']
    const comparable = { ...current, brand_colour: typeof current.brand_colour === 'string' ? current.brand_colour.toLowerCase() : current.brand_colour }
    const { changedKeys, changes } = diffFields(comparable, proposed, REDACT)
    if (changedKeys.length === 0) return NextResponse.json({ ok: true, unchanged: true })

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const key of changedKeys) updates[key] = proposed[key]

    const { error } = await service.from('workspaces').update(updates).eq('id', session.workspaceId)
    if (error) {
      console.error('Workspace branding update failed:', error)
      return NextResponse.json({ error: 'Failed to update branding' }, { status: 500 })
    }

    const signatureOnly = changedKeys.length === 1 && changedKeys[0] === 'agency_signature_data'
    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: signatureOnly
        ? (proposed.agency_signature_data === null ? 'workspace.signature_removed' : 'workspace.signature_updated')
        : 'workspace.branding_updated',
      entityType: 'workspace', entityId: session.workspaceId, entityName: session.workspaceName,
      metadata: { fields: changedKeys, changes },
    })

    return NextResponse.json({ ok: true, changed: changedKeys })
  } catch (err) {
    console.error('Workspace branding error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

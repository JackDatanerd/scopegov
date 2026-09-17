import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'

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
    // FIX (deep audit, Settings re-pass): brand_colour was accepted as an
    // arbitrary string with no format check, then interpolated raw into
    // HTML email templates as `style="background:${headerColour}"` (see
    // lib/email/templates.ts baseTemplate) — used on every outbound
    // SOW/CO/invoice/reminder email. A value containing a `"` could break
    // out of the style attribute and inject markup into every subsequent
    // client-facing email sent from this workspace. Constrain to an
    // actual hex colour before it ever reaches storage.
    if (brandColour !== undefined) {
      if (typeof brandColour !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(brandColour)) {
        return NextResponse.json({ error: 'Brand colour must be a hex colour, e.g. #1A5C3A' }, { status: 400 })
      }
      updates.brand_colour = brandColour
    }
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
    // FIX (deep audit, Settings re-pass): agencySignatureData was accepted
    // as an arbitrary string with zero validation before being stored and
    // later handed straight to react-pdf's <Image src={...}> in
    // lib/pdf/renderer.tsx for every auto-signed SOW/CO. react-pdf's
    // Image component fetches whatever URL it's given at render time —
    // a non-data: value here (an internal/cloud-metadata URL, or simply
    // an attacker-controlled remote host) would make the PDF-generation
    // server issue that fetch itself, an SSRF vector, on top of an
    // unbounded string being persisted with no size limit. Only a real
    // signature.toDataURL('image/png')-shaped value (see
    // components/ui/SignaturePad.tsx) — or an explicit null to clear it —
    // is ever legitimate here.
    if (agencySignatureData !== undefined && agencySignatureData !== null) {
      const isValidSignatureDataUrl =
        typeof agencySignatureData === 'string' &&
        agencySignatureData.length <= 2_000_000 &&
        /^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/]+=*$/.test(agencySignatureData)
      if (!isValidSignatureDataUrl) {
        return NextResponse.json({ error: 'Invalid signature image' }, { status: 400 })
      }
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

    // FIX (deep audit, section 5 re-pass): this route changes the agency's
    // brand colour, logo, and — most materially — agency_signature_data,
    // which is auto-applied as a binding signature on every SOW/CO sent
    // from here on. None of that was ever recorded in the audit trail,
    // unlike every other workspace-settings mutation. Log which fields
    // changed; the signature image itself is deliberately excluded from
    // metadata (it's a data URL, not something an audit row should carry).
    if (Object.keys(updates).length > 1) {
      const changedFields = Object.keys(updates).filter(k => k !== 'updated_at')
      await logAudit(service, {
        workspaceId: session.workspaceId, actorId: session.id,
        actorEmail: session.email, actorName: session.name,
        eventType: agencySignatureData !== undefined && Object.keys(updates).length === (updates.updated_at ? 2 : 1)
          ? (agencySignatureData === null ? 'workspace.signature_removed' : 'workspace.signature_updated')
          : 'workspace.branding_updated',
        entityType: 'workspace', entityId: session.workspaceId, entityName: session.workspaceName,
        metadata: { fields: changedFields },
      })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

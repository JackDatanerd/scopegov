export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { diffFields } from '@/lib/utils/audit-diff'
import { sameInstant } from '@/lib/utils/timestamps'
// FIX (deep audit, client-facing/signing section — feature gap): see this module's own comment —
// nothing ever checked a saved brand colour for legibility as white button text before this.
import { isLowContrastForWhiteText } from '@/lib/utils/colour-contrast'

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
    const { workspaceId: expectedWorkspaceId, expectedUpdatedAt, expected, brandColour, logoStoragePath, agencySignatureData } = body as Record<string, unknown>
    // FIX (Settings independent pass 5 — B5): optional per-field baseline — see the conflict check below.
    if (expected !== undefined && (expected === null || typeof expected !== 'object' || Array.isArray(expected))) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }
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

    // FIX (Settings independent pass 5 — B5): `expected` carries what the editor loaded for the fields it is
    // writing: { brandColour?, logoStoragePath?, hasSignature? }. The save is refused only when one of THOSE
    // fields has since changed. expectedUpdatedAt (below, kept for older callers) is the whole row's timestamp,
    // which a billing webhook, a plan change or a governing-law save also moves — so a person saving a colour
    // was told "changed elsewhere" although nothing about branding had changed. When `expected` is present it
    // replaces the timestamp check.
    const exp = (expected ?? null) as Record<string, unknown> | null
    const REDACT = ['agency_signature_data']
    let current: any = null
    let changedKeys: string[] = []
    let changes: Record<string, unknown> = {}
    let updates: Record<string, unknown> = {}
    let written: any[] | null = null

    // The compare-and-swap below can lose a race to an unrelated write to the same row. With a per-field
    // baseline that is not a conflict, so read again and re-check once before giving up.
    for (let attempt = 0; attempt < (exp ? 3 : 1); attempt++) {
      const { data, error: currentErr } = await service
        .from('workspaces').select('brand_colour, logo_storage_path, agency_signature_data, updated_at')
        .eq('id', session.workspaceId).single()
      if (currentErr || !data) {
        console.error('Workspace branding: could not load workspace:', currentErr)
        return NextResponse.json({ error: 'Failed to update branding' }, { status: 500 })
      }
      current = data

      if (exp) {
        const conflicts: string[] = []
        if ('brand_colour' in proposed && exp.brandColour !== undefined &&
            String(exp.brandColour).toLowerCase() !== String(current.brand_colour ?? '').toLowerCase()) conflicts.push('brandColour')
        if ('logo_storage_path' in proposed && exp.logoStoragePath !== undefined &&
            (exp.logoStoragePath || null) !== (current.logo_storage_path || null)) conflicts.push('logoStoragePath')
        if ('agency_signature_data' in proposed && exp.hasSignature !== undefined &&
            !!exp.hasSignature !== !!current.agency_signature_data) conflicts.push('agencySignatureData')
        if (conflicts.length > 0) {
          return NextResponse.json({
            error: 'Branding was changed elsewhere since you loaded this page.',
            conflicts,
          }, { status: 409 })
        }
      } else if (typeof expectedUpdatedAt === 'string' && !sameInstant(expectedUpdatedAt, current.updated_at)) {
        // FIX (deep audit, Settings independent re-pass): unlike /api/workspace/settings (which compares every
        // field's pre-edit value against what the DB actually holds before writing) this route wrote straight
        // through with no staleness check at all. Compare INSTANTS, not text: this route and the logo route
        // return `new Date().toISOString()` ("...155Z") while PostgREST returns "...155+00:00" (and may carry
        // microseconds), so a strict string comparison refused a person's own previous save.
        return NextResponse.json({
          error: 'Branding was changed elsewhere since you loaded this page.',
          conflicts: ['branding'],
        }, { status: 409 })
      }

      // The signature image itself is never written to the audit trail.
      const comparable = { ...current, brand_colour: typeof current.brand_colour === 'string' ? current.brand_colour.toLowerCase() : current.brand_colour }
      const diff = diffFields(comparable, proposed, REDACT)
      changedKeys = diff.changedKeys
      changes = diff.changes
      // FIX (deep audit, Settings re-pass round 2): include updatedAt on the unchanged path too — a caller that
      // is only learning the current value rather than reacting to a real change still needs it.
      if (changedKeys.length === 0) return NextResponse.json({ ok: true, unchanged: true, updatedAt: current.updated_at })

      updates = { updated_at: new Date().toISOString() }
      for (const key of changedKeys) updates[key] = proposed[key]

      // Compare-and-swap on updated_at, like /api/workspace/settings: the staleness check above and this write
      // are two round trips, so two admins saving at the same instant could both pass it. Only write if the row
      // is still the one we read.
      let write = service.from('workspaces').update(updates).eq('id', session.workspaceId)
      if (current.updated_at) write = write.eq('updated_at', current.updated_at)
      const { data: w, error } = await write.select('id')
      if (error) {
        console.error('Workspace branding update failed:', error)
        return NextResponse.json({ error: 'Failed to update branding' }, { status: 500 })
      }
      if (w && w.length > 0) { written = w; break }
    }
    if (!written || written.length === 0) {
      return NextResponse.json({
        error: 'Branding was changed elsewhere since you loaded this page.',
        conflicts: ['branding'],
      }, { status: 409 })
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

    // FIX (deep audit, client-facing/signing section — feature gap): only fires the moment the
    // colour actually changes to a problematic one (not on every subsequent unrelated save while
    // it's set) — see colour-contrast.ts's own comment for why this check exists at all. The
    // Settings UI already surfaces any `warning` field from this route (see SettingsClient.tsx's
    // shared `patch()` helper), so no client-side plumbing was needed for this half of the fix.
    const warning = changedKeys.includes('brand_colour') && isLowContrastForWhiteText(proposed.brand_colour as string)
      ? 'This brand colour may be hard to read as white text — it\u2019s used on "Sign"/"Pay" buttons in the client portal and on the button in every client-facing email. Consider a darker or more saturated shade.'
      : undefined

    // FIX (deep audit, Settings re-pass round 2 — false-conflict bug):
    // returning the new updated_at lets the caller update its own cached
    // baseline immediately, without waiting on router.refresh() to bring a
    // fresh `workspace` prop back down — see BrandingTab's freshUpdatedAt
    // state, and this route's own expectedUpdatedAt comment above for the
    // conflict this closes the loop on.
    return NextResponse.json({ ok: true, changed: changedKeys, updatedAt: updates.updated_at, ...(warning ? { warning } : {}) })
  } catch (err) {
    console.error('Workspace branding error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

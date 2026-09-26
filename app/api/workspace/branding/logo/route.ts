export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'

// FIX (audit round 3, finding #5): the browser previously wrote logo
// files straight to Supabase Storage (`supabase.storage.from('logos')
// .upload(...)`) using the anon-key client. The MANAGE_WORKSPACE_SETTINGS
// check in components/settings/SettingsClient.tsx that gated this was
// client-side JS only — trivially bypassable by calling the Storage API
// directly with an authenticated user's own session, regardless of their
// actual permissions. Storage bucket policies for `logos` also aren't
// tracked anywhere in this repo's migrations, so enforcement couldn't be
// verified to exist at all at that layer.
//
// This route moves the write behind the same server-side permission
// check every other mutation in the app already goes through, and
// performs the actual Storage write with the service-role client (which
// bypasses Storage RLS entirely), removing the browser from the write
// path altogether.

// FIX (audit round 5): this route allowed image/svg+xml with no content
// verification at all, uploaded straight to the PUBLIC `logos` bucket.
// Unlike the flag-evidence attachment route (which checks magic bytes
// AND lives behind signed URLs in a private bucket), a spoofed or
// genuinely SVG file here is served publicly from Supabase's own domain.
// SVGs can carry live <script> — if the raw storage URL is ever opened
// directly (not via an <img> tag, which browsers sandbox), that script
// executes in the storage origin. Since every workspace's public logo
// lives in the same bucket, this is a real stored-XSS/phishing vector,
// not a theoretical one.
//
// Fix, product-scoped: drop SVG support entirely rather than building and
// maintaining a bespoke SVG sanitizer (strip <script>, <foreignObject>,
// event-handler attributes, external hrefs, etc.) for a single low-value
// upload path. PNG/JPG covers every real agency-logo use case. If SVG
// support is genuinely needed later, it needs a dedicated sanitizer
// (e.g. DOMPurify's SVG profile), not a quick allowlist tweak here.
//
// Also adds the same magic-byte check the attachments route already has
// — file.type is client-supplied and was previously trusted both as the
// allowlist gate AND the stored object's Content-Type.
const MAX_LOGO_BYTES = 2 * 1024 * 1024 // 2MB, matches the existing client-side limit
const ALLOWED_TYPES: Record<string, string> = {
  'image/png':  'png',
  'image/jpeg': 'jpg',
}
const MAGIC_BYTES: Record<string, (buf: Buffer) => boolean> = {
  'image/png':  buf => buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': buf => buf.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS')) {
      return NextResponse.json({ error: 'Missing permission: MANAGE_WORKSPACE_SETTINGS' }, { status: 403 })
    }

    const formData = await request.formData()
    const file = formData.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    const ext = ALLOWED_TYPES[file.type]
    if (!ext) {
      return NextResponse.json({ error: 'Please upload a PNG or JPG file.' }, { status: 400 })
    }
    if (file.size > MAX_LOGO_BYTES) {
      return NextResponse.json(
        { error: `File is too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max size is 2MB.` },
        { status: 400 }
      )
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    if (!MAGIC_BYTES[file.type](buffer)) {
      return NextResponse.json({ error: 'File content does not match its declared type' }, { status: 400 })
    }

    const service = createServiceClient()
    // Path is derived server-side from the caller's own session workspace,
    // never trusted from the client — a member can only ever overwrite
    // their own workspace's logo.
    const path = `${session.workspaceId}/logo.${ext}`
    const bytes = new Uint8Array(buffer)

    // FIX (deep audit, section 5 re-pass): the path is keyed by extension
    // (logo.png vs logo.jpg), so switching file types (upload a PNG, later
    // switch to a JPG) never overwrote the old object — `upsert: true`
    // only replaces an object at the exact same path. The previous logo
    // was left behind in the public bucket forever, unreferenced. Look up
    // whatever's currently on record and, if this upload lands at a
    // different path, remove the stale one after the new one is safely in
    // place. Best-effort: a failure here shouldn't fail the upload itself.
    const { data: existingWs } = await (service as any)
      .from('workspaces').select('logo_storage_path').eq('id', session.workspaceId).maybeSingle()
    const previousPath: string | undefined = existingWs?.logo_storage_path

    const { error } = await (service as any).storage
      .from('logos')
      // `cacheControl: '60'` pairs with the ?v= cache-buster that
      // app/(app)/settings/page.tsx now appends: the versioned URL is what
      // actually guarantees a replacement is seen immediately, and this
      // just keeps the window small for any consumer holding a bare,
      // unversioned URL (a previously-generated PDF, an already-sent
      // email). Default was 3600, which is what made a same-extension
      // logo replacement invisible for up to an hour.
      .upload(path, bytes, { upsert: true, contentType: file.type, cacheControl: '60' })

    if (error) {
      console.error('Logo upload error:', error)
      return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
    }

    // FIX (deep audit, Settings re-pass — logo/branding race): this route
    // used to delete the previous logo from storage right here, but the
    // workspace's own `logo_storage_path` column was only ever updated by
    // a SEPARATE, later PATCH /api/workspace/branding call made by the
    // client (see SettingsClient.tsx's saveBranding). Those are two
    // independent HTTP round-trips — if the second one failed for any
    // reason (network drop, the person closing the tab, a validation
    // error on the colour field bundled into the same request) after a
    // successful upload with a different file extension, the old logo was
    // already gone from storage while the DB still pointed at it (a
    // broken image), and the newly uploaded file sat orphaned, never
    // linked to anything. Persist the association here, in the same
    // request that performs the upload, so the two can never desync —
    // only delete the stale object once the workspace row durably points
    // at the new one. The client's subsequent branding PATCH (which also
    // carries brandColour) still sends logoStoragePath along and simply
    // re-writes the same value; that's a harmless no-op, not a race.
    // FIX (deep audit, Settings re-pass round 2 — false-conflict bug): this
    // route's own comment above already explains why it writes updated_at
    // itself (to keep the Storage object and the DB row from desyncing).
    // But that means the workspace's updated_at moves WITHOUT the client's
    // cached copy (SettingsClient's `workspace` prop, only refreshed by
    // router.refresh() after the *next* branding PATCH resolves) ever
    // learning about it. saveBranding() immediately follows this upload
    // with a PATCH /api/workspace/branding carrying the stale
    // expectedUpdatedAt it loaded the page with — that PATCH's own
    // optimistic-concurrency check (see its comment) then refuses its own
    // request as "changed elsewhere," every time a logo and any other
    // branding field are saved together. Returning the fresh timestamp
    // here lets the client use it for that immediate next call instead of
    // waiting on a round trip that hasn't happened yet.
    const logoUpdatedAt = new Date().toISOString()
    const { error: linkErr } = await (service as any)
      .from('workspaces')
      .update({ logo_storage_path: path, updated_at: logoUpdatedAt })
      .eq('id', session.workspaceId)

    if (linkErr) {
      console.error('Logo association update failed:', linkErr)
      // Don't touch the previous logo — it's still the one the workspace
      // actually references. The newly uploaded object is orphaned but
      // harmless; a retry will just upsert over it at the same path.
      return NextResponse.json({ error: 'Upload succeeded but could not be saved. Try again.' }, { status: 500 })
    }

    if (previousPath && previousPath !== path) {
      const { error: removeErr } = await (service as any).storage.from('logos').remove([previousPath])
      if (removeErr) console.error('Stale logo cleanup failed (non-fatal):', removeErr)
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.logo_uploaded', entityType: 'workspace',
      entityId: session.workspaceId, entityName: session.workspaceName,
      metadata: { path },
    })

    return NextResponse.json({ logoStoragePath: path, updatedAt: logoUpdatedAt })
  } catch (err) {
    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): outer
    // catch-all returned a raw exception message — same info-disclosure
    // pattern already fixed elsewhere in this section, missed here even
    // though this is onboarding step 1's logo upload path.
    console.error('Logo upload route error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// FIX (deep audit, section 5 — feature gap): there was no way to remove a
// logo once uploaded anywhere in the app. POST only ever upserts a new
// file, and PATCH /api/workspace/branding's `if (logoStoragePath && ...)`
// truthy-check meant even a client sending `null`/`''` to explicitly
// clear it was silently ignored — the exact same "clear via explicit
// null" shape agencySignatureData already supports on that same route.
// A dedicated DELETE here (rather than overloading PATCH) keeps the
// Storage removal and the DB column update in the same request, same
// reasoning as POST's own upload+link-in-one-request fix above.
export async function DELETE() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS')) {
      return NextResponse.json({ error: 'Missing permission: MANAGE_WORKSPACE_SETTINGS' }, { status: 403 })
    }

    const service = createServiceClient()

    const { data: ws } = await (service as any)
      .from('workspaces').select('logo_storage_path').eq('id', session.workspaceId).maybeSingle()
    const currentPath: string | undefined = ws?.logo_storage_path

    if (!currentPath) {
      // Nothing to remove — treat as a harmless no-op rather than an error.
      return NextResponse.json({ ok: true })
    }

    // FIX (deep audit, Settings re-pass round 2 — same false-conflict bug
    // as POST above): return the fresh updated_at so a subsequent branding
    // save in the same session doesn't race its own stale cached copy.
    const removeUpdatedAt = new Date().toISOString()
    const { error: clearErr } = await (service as any)
      .from('workspaces')
      .update({ logo_storage_path: null, updated_at: removeUpdatedAt })
      .eq('id', session.workspaceId)

    if (clearErr) {
      console.error('Logo removal (DB) failed:', clearErr)
      return NextResponse.json({ error: 'Could not remove logo. Try again.' }, { status: 500 })
    }

    // Same ordering as POST: only delete the Storage object once the
    // workspace row durably no longer points at it. Best-effort — a
    // failure here leaves an orphaned-but-harmless file behind, not a
    // broken image reference.
    const { error: removeErr } = await (service as any).storage.from('logos').remove([currentPath])
    if (removeErr) console.error('Logo storage removal failed (non-fatal):', removeErr)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.logo_removed', entityType: 'workspace',
      entityId: session.workspaceId, entityName: session.workspaceName,
      metadata: { path: currentPath },
    })

    return NextResponse.json({ ok: true, updatedAt: removeUpdatedAt })
  } catch (err) {
    console.error('Logo removal route error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

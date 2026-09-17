export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'

// FIX (deep audit, Workspace lifecycle + Onboarding re-pass — feature
// gap): `users.avatar_url` has been a real column since 001_initial_schema,
// and is already selected and threaded through as a prop in the Team page,
// project member lists, and project discussion threads — but there has
// never been any route, storage wiring, or UI control anywhere in the app
// that sets it. It's schema and consumers with no producer. This route is
// that producer; see components/settings/SettingsClient.tsx's AccountTab
// for where it's now wired up, and the same three read sites for where the
// value is now actually rendered (they previously only ever computed
// colored initials, ignoring avatar_url even where it was already in
// scope).
//
// No dedicated `avatars` bucket exists anywhere in this repo (bucket
// creation isn't tracked in the SQL migrations at all — `logos` is the
// only bucket referenced in code, and per 002_signatures.sql's own note,
// buckets are provisioned outside this repo). Rather than depend on a new
// bucket being created out-of-band before this can ship, this reuses the
// existing public `logos` bucket under a distinct `avatars/` prefix — same
// exposure profile as a workspace logo (public, low-sensitivity image),
// zero new infrastructure required. If a dedicated bucket is provisioned
// later, moving this is a one-line change (the bucket name below).
const AVATAR_BUCKET = 'logos'
const MAX_AVATAR_BYTES = 2 * 1024 * 1024 // 2MB, matches the logo upload limit
const ALLOWED_TYPES: Record<string, string> = {
  'image/png':  'png',
  'image/jpeg': 'jpg',
}
// Same magic-byte check as workspace/branding/logo/route.ts, for the same
// reason: file.type is client-supplied and isn't trustworthy on its own,
// and this lands in the same public bucket that route already had to
// defend (see that route's own comment on the SVG stored-XSS vector this
// sidesteps entirely by only ever accepting PNG/JPEG here too).
const MAGIC_BYTES: Record<string, (buf: Buffer) => boolean> = {
  'image/png':  buf => buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': buf => buf.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
}

// avatar_url stores a ready-to-use public URL (not a bare storage path —
// unlike logo_storage_path, every existing consumer of avatar_url expects
// to use it directly as an <img src>). The path is still deterministic
// (keyed on the user's own id), so it can always be reconstructed for
// cleanup without needing a second column to remember it.
function possiblePaths(userId: string): string[] {
  return Object.values(ALLOWED_TYPES).map(ext => `avatars/${userId}.${ext}`)
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const formData = await request.formData()
    const file = formData.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    const ext = ALLOWED_TYPES[file.type]
    if (!ext) {
      return NextResponse.json({ error: 'Please upload a PNG or JPG file.' }, { status: 400 })
    }
    if (file.size > MAX_AVATAR_BYTES) {
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
    // Path is derived server-side from the caller's own session id, never
    // trusted from the client — a user can only ever overwrite their own
    // avatar, not anyone else's.
    const path = `avatars/${session.id}.${ext}`
    const bytes = new Uint8Array(buffer)

    const { error } = await (service as any).storage
      .from(AVATAR_BUCKET)
      .upload(path, bytes, { upsert: true, contentType: file.type })

    if (error) {
      console.error('Avatar upload error:', error)
      return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
    }

    // Same stale-object lesson as workspace/branding/logo/route.ts (round-5
    // fix there): if the user's new file is a different type than their
    // last one (JPG replacing a PNG, say), the two live at different paths
    // and `upsert: true` only overwrites an exact path match — clean up
    // the other possible extension so it isn't left behind forever.
    const otherPath = possiblePaths(session.id).find(p => p !== path)
    if (otherPath) {
      const { error: removeErr } = await (service as any).storage.from(AVATAR_BUCKET).remove([otherPath])
      if (removeErr) console.error('Stale avatar cleanup failed (non-fatal):', removeErr)
    }

    const { data: pub } = (service as any).storage.from(AVATAR_BUCKET).getPublicUrl(path)
    // Cache-bust: the path is stable per user, so an unchanged URL string
    // would otherwise keep serving a browser's cached copy of the old image
    // after a re-upload.
    const avatarUrl = `${pub.publicUrl}?v=${Date.now()}`

    const { error: dbError } = await (service as any).from('users')
      .update({ avatar_url: avatarUrl, updated_at: new Date().toISOString() })
      .eq('id', session.id)
    if (dbError) {
      console.error('Avatar URL save failed:', dbError)
      return NextResponse.json({ error: 'Failed to save avatar' }, { status: 500 })
    }

    return NextResponse.json({ avatarUrl })
  } catch (err) {
    console.error('Avatar upload route error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()
    const { error: removeErr } = await (service as any).storage
      .from(AVATAR_BUCKET)
      .remove(possiblePaths(session.id))
    // Best-effort: an already-missing object shouldn't block clearing the
    // column — the two states (storage object gone, column cleared) don't
    // need to succeed atomically for a low-stakes personal image.
    if (removeErr) console.error('Avatar removal failed (non-fatal):', removeErr)

    const { error: dbError } = await (service as any).from('users')
      .update({ avatar_url: null, updated_at: new Date().toISOString() })
      .eq('id', session.id)
    if (dbError) {
      console.error('Avatar clear failed:', dbError)
      return NextResponse.json({ error: 'Failed to remove avatar' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Avatar removal route error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

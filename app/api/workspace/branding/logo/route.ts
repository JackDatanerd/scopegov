export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'

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

const MAX_LOGO_BYTES = 2 * 1024 * 1024 // 2MB, matches the existing client-side limit
const ALLOWED_TYPES: Record<string, string> = {
  'image/png':     'png',
  'image/jpeg':    'jpg',
  'image/svg+xml': 'svg',
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
      return NextResponse.json({ error: 'Please upload a PNG, JPG, or SVG file.' }, { status: 400 })
    }
    if (file.size > MAX_LOGO_BYTES) {
      return NextResponse.json(
        { error: `File is too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max size is 2MB.` },
        { status: 400 }
      )
    }

    const service = createServiceClient()
    // Path is derived server-side from the caller's own session workspace,
    // never trusted from the client — a member can only ever overwrite
    // their own workspace's logo.
    const path = `${session.workspaceId}/logo.${ext}`
    const bytes = new Uint8Array(await file.arrayBuffer())

    const { error } = await (service as any).storage
      .from('logos')
      .upload(path, bytes, { upsert: true, contentType: file.type })

    if (error) {
      console.error('Logo upload error:', error)
      return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
    }

    return NextResponse.json({ logoStoragePath: path })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}

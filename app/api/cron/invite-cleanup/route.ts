export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'

// FIX (audit round 3): local copy replaced with the shared,
// null-safe helper — see lib/utils/verify-cron.ts.

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service  = createServiceClient()
    const now      = new Date()
    const d7ago    = new Date(now.getTime() - 7  * 86400000).toISOString()
    const d30ago   = new Date(now.getTime() - 30 * 86400000).toISOString()

    // Hard-delete invite rows older than 30 days
    const { data: purged } = await (service as any)
      .from('workspace_members')
      .delete()
      .eq('status', 'invited')
      .lt('invite_token_expires_at', d30ago)
      .select('id')

    // revoked_tokens cleanup (purge rows older than 60 days)
    const d60ago = new Date(now.getTime() - 60 * 86400000).toISOString()
    await (service as any).from('revoked_tokens')
      .delete()
      .lt('revoked_at', d60ago)

    // User anonymization (deletedAt < now - 30 days)
    const { data: toAnonymize } = await (service as any)
      .from('users')
      .select('id')
      .not('deleted_at', 'is', null)
      .lt('deleted_at', d30ago)

    let anonymized = 0
    for (const u of (toAnonymize || [])) {
      try {
        await (service as any).from('users').update({
          email:        `deleted-${u.id}@deleted.scopegov.app`,
          name:         '[Deleted user]',
          avatar_url:   null,
          updated_at:   now.toISOString(),
        }).eq('id', u.id)
        anonymized++
      } catch (e) { console.error('Anonymization failed for:', u.id, e) }
    }

    return NextResponse.json({
      ok: true,
      purgedInvites: purged?.length || 0,
      anonymizedUsers: anonymized,
    })
  } catch (err) {
    console.error('Cleanup cron error:', err)
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// FIX (cron): Vercel Cron Jobs invoke the configured path with a GET
// request, not POST — every route here only exported POST, so all 6 jobs
// wired up in vercel.json would 405 the moment Vercel actually triggered
// them. The 3 sub-hourly jobs (sow-stall, co-stall, guardian-health) are
// triggered by the GitHub Actions workflow via POST, which still works.
// Exporting GET as an alias makes both invocation paths work.
export const GET = POST

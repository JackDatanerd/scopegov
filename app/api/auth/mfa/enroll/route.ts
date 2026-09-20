export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

// Starts TOTP enrollment. Returns a QR code (SVG data URI, rendered by
// Supabase itself) plus the raw secret for manual entry. The factor is
// "unverified" until POST /api/auth/mfa/verify confirms a code — Supabase
// auto-expires unverified factors after a few minutes, so a stale
// half-finished enrollment never lingers.
export async function POST() {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Clear out any dangling unverified factor from an abandoned previous
    // attempt first — Supabase allows multiple factors, but we only ever
    // want one active TOTP factor per user for a single, unambiguous
    // enrollment state in the UI.
    const { data: existing } = await supabase.auth.mfa.listFactors()
    // FIX (build — Auth independent audit, LOW): only the FIRST stale factor was
    // cleaned up and the result was never checked. A leftover half-enrolled
    // factor blocks the next enrol with GoTrue's "friendly name already exists"
    // conflict, leaving the user stuck on the setup screen.
    const staleFactors = (existing?.all || []).filter(f => f.factor_type === 'totp' && f.status === 'unverified')
    for (const stale of staleFactors) {
      const { error: cleanupErr } = await supabase.auth.mfa.unenroll({ factorId: stale.id })
      if (cleanupErr) console.error('MFA enroll: could not remove stale factor', stale.id, cleanupErr.message)
    }
    const alreadyVerified = (existing?.totp || [])[0]
    if (alreadyVerified) {
      return NextResponse.json({ error: 'Two-factor authentication is already enabled. Disable it first to re-enroll.' }, { status: 409 })
    }

    let { data, error } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Authenticator app',
    })
    if (error && ((error as any).code === 'mfa_factor_name_conflict' || /friendly name/i.test(error.message))) {
      // A stale factor we couldn't remove still holds the default name — enrol
      // under a unique one rather than failing the whole setup.
      ;({ data, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: `Authenticator app ${Math.random().toString(36).slice(2, 8)}`,
      }))
    }
    if (error || !data) return NextResponse.json({ error: error?.message || 'Could not start enrollment' }, { status: 400 })

    return NextResponse.json({
      factorId: data.id,
      qrCode:   data.totp.qr_code, // SVG data URI, ready to drop into an <img>
      secret:   data.totp.secret,  // for manual entry
      uri:      data.totp.uri,
    })
  } catch (err) {
    console.error('MFA enroll error:', err)
    return NextResponse.json({ error: 'Could not start enrollment' }, { status: 500 })
  }
}

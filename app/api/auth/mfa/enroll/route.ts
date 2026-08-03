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
    const unverified = (existing?.all || []).find(f => f.factor_type === 'totp' && f.status === 'unverified')
    if (unverified) {
      await supabase.auth.mfa.unenroll({ factorId: unverified.id })
    }
    const alreadyVerified = (existing?.totp || [])[0]
    if (alreadyVerified) {
      return NextResponse.json({ error: 'Two-factor authentication is already enabled. Disable it first to re-enroll.' }, { status: 409 })
    }

    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Authenticator app',
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })

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

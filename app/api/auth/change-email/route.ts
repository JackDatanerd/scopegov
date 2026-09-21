export const runtime = 'nodejs'

// POST /api/auth/change-email — start a change of the SIGN-IN email.
//
// There was no in-product way to do this, yet GoTrue lets any signed-in browser
// call updateUser({ email }) directly with the public anon key — an unguarded
// path, and one whose safety depended on a dashboard toggle nobody had documented.
// This is the guarded path: it needs a step-up (recent password / TOTP), MFA-
// mandatory accounts must be at aal2, the CURRENT address is told about it, and
// nothing changes until the confirmation link(s) are followed (README §1.3: keep
// "Secure email change" ON so BOTH addresses must confirm).

import { NextResponse, type NextRequest } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { requireStepUp } from '@/lib/auth/step-up'
import { logSecurityAudit } from '@/lib/auth/security-audit'
import { resolveActiveWorkspaceId, resolveActorName } from '@/lib/auth/session'
import { notifySecurityEvent } from '@/lib/utils/notify'
import { sendEmailChangeRequestedEmail } from '@/lib/email/templates'

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => null) as { newEmail?: unknown } | null
    const newEmail = typeof body?.newEmail === 'string' ? body.newEmail.trim().toLowerCase() : ''
    if (!newEmail || newEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 })
    }
    if (newEmail === (user.email || '').toLowerCase()) {
      return NextResponse.json({ error: 'That is already your sign-in email.' }, { status: 400 })
    }

    const service = createServiceClient() as any
    const stepUp = await requireStepUp(supabase, service, user)
    if (stepUp) return stepUp

    const origin = new URL(request.url).origin
    const { error } = await supabase.auth.updateUser(
      { email: newEmail },
      { emailRedirectTo: `${origin}/api/auth/callback?next=/settings` }
    )
    if (error) {
      const code = (error as any).code as string | undefined
      if (code === 'email_exists' || /already (been )?registered|already exists/i.test(error.message)) {
        return NextResponse.json({ error: 'That email address is already used by another account.' }, { status: 409 })
      }
      if (code === 'insufficient_aal' || /aal2/i.test(error.message)) {
        return NextResponse.json({ error: 'Verify your authenticator code to continue.', code: 'mfa_required' }, { status: 403 })
      }
      if ((error as any).status === 429 || code === 'over_email_send_rate_limit') {
        return NextResponse.json({ error: 'Too many requests. Wait a few minutes and try again.' }, { status: 429 })
      }
      return NextResponse.json({ error: error.message }, { status: 400 })
    }

    const actorName = await resolveActorName(service, user.id, user.user_metadata?.name || user.email!)
    await logSecurityAudit(service, {
      actorId: user.id, actorEmail: user.email!, actorName,
      eventType: 'security.email_change_requested', entityId: user.id, entityName: user.email!,
      metadata: { new_email: newEmail }, fallbackWorkspaceId: await resolveActiveWorkspaceId(service, user.id),
    })
    await notifySecurityEvent(service, user.id, 'Sign-in email change requested',
      'A change of your sign-in email was requested. Nothing changes until the new address is confirmed.')
    await sendEmailChangeRequestedEmail({ to: user.email!, name: actorName, newEmail, settingsUrl: `${origin}/settings?tab=account` })
      .catch(e => console.error('Email-change notice failed (non-fatal):', e))

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Change email error:', err)
    return NextResponse.json({ error: 'Could not start the email change' }, { status: 500 })
  }
}

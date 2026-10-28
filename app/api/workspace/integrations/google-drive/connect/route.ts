export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { requireStepUpForCurrentUser } from '@/lib/auth/step-up'
import { requireIntegrationAdmin } from '@/lib/integrations/guard'
import { integrationCryptoConfigured } from '@/lib/integrations/crypto'
import { googleAuthorizeUrl, googleConfigured, signGoogleState } from '@/lib/integrations/google-config'

// Starts "Connect Google Drive": returns Google's consent URL. A POST so it can demand a recent re-authentication first
// (connecting a company's file storage is a security-relevant act). The `state` is bound to this workspace and person;
// the callback refuses anything else.
export async function POST() {
  try {
    const auth = await requireIntegrationAdmin('google_drive')
    if ('response' in auth) return auth.response
    const { session } = auth
    if (!googleConfigured() || !integrationCryptoConfigured())
      return NextResponse.json({ error: 'Google Drive is not set up on this server yet (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, INTEGRATIONS_ENCRYPTION_KEY).' }, { status: 503 })
    const stepUp = await requireStepUpForCurrentUser()
    if (stepUp) return stepUp
    const url = googleAuthorizeUrl(signGoogleState({ ws: session.workspaceId, uid: session.id }))
    if (!url) return NextResponse.json({ error: 'NEXT_PUBLIC_APP_URL is not set, so Google cannot be given a return address.' }, { status: 503 })
    return NextResponse.json({ url })
  } catch (err) {
    console.error('Google Drive connect error:', err)
    return NextResponse.json({ error: 'Could not start the Google Drive connection. Please try again.' }, { status: 500 })
  }
}

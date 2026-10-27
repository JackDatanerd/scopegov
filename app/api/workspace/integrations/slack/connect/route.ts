export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { requireStepUpForCurrentUser } from '@/lib/auth/step-up'
import { requireIntegrationAdmin } from '@/lib/integrations/guard'
import { integrationCryptoConfigured } from '@/lib/integrations/crypto'
import { signState, slackAuthorizeUrl, slackConfigured } from '@/lib/integrations/slack-config'

// Starts "Add to Slack": returns the Slack authorize URL for the browser to go to. A POST (not a plain link) so it can
// demand a recent re-authentication first — connecting a workspace's chat is a security-relevant act. The `state` it
// carries is bound to this workspace and this person; the callback refuses anything else.
export async function POST() {
  try {
    const auth = await requireIntegrationAdmin('slack')
    if ('response' in auth) return auth.response
    const { session } = auth
    if (!slackConfigured() || !integrationCryptoConfigured())
      return NextResponse.json({ error: 'Slack is not set up on this server yet (SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, INTEGRATIONS_ENCRYPTION_KEY).' }, { status: 503 })
    const stepUp = await requireStepUpForCurrentUser()
    if (stepUp) return stepUp
    const url = slackAuthorizeUrl(signState({ ws: session.workspaceId, uid: session.id }))
    if (!url) return NextResponse.json({ error: 'NEXT_PUBLIC_APP_URL is not set, so Slack cannot be given a return address.' }, { status: 503 })
    return NextResponse.json({ url })
  } catch (err) {
    console.error('Slack connect error:', err)
    return NextResponse.json({ error: 'Could not start the Slack connection. Please try again.' }, { status: 500 })
  }
}

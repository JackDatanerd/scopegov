export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { hasPermission } from '@/lib/auth/session'
import { requireStepUpForCurrentUser } from '@/lib/auth/step-up'
import { requireIntegrationAdmin } from '@/lib/integrations/guard'
import { integrationCryptoConfigured } from '@/lib/integrations/crypto'
import { hubspotAuthorizeUrl, hubspotConfigured, signHubspotState } from '@/lib/integrations/hubspot-config'

// Starts "Connect HubSpot": returns HubSpot's consent URL. A POST so it can demand a recent re-authentication. Syncing sends client
// names, emails and phone numbers to the CRM, so the person connecting must be someone allowed to see client data in ScopeGov.
export async function POST() {
  try {
    const auth = await requireIntegrationAdmin('hubspot')
    if ('response' in auth) return auth.response
    const { session } = auth
    if (!hasPermission(session, 'VIEW_CLIENT_DATA'))
      return NextResponse.json({ error: 'Missing permission: VIEW_CLIENT_DATA (HubSpot sync shares client contact details).' }, { status: 403 })
    if (!hubspotConfigured() || !integrationCryptoConfigured())
      return NextResponse.json({ error: 'HubSpot is not set up on this server yet (HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET, INTEGRATIONS_ENCRYPTION_KEY).' }, { status: 503 })
    const stepUp = await requireStepUpForCurrentUser()
    if (stepUp) return stepUp
    const url = hubspotAuthorizeUrl(signHubspotState({ ws: session.workspaceId, uid: session.id }))
    if (!url) return NextResponse.json({ error: 'NEXT_PUBLIC_APP_URL is not set, so HubSpot cannot be given a return address.' }, { status: 503 })
    return NextResponse.json({ url })
  } catch (err) {
    console.error('HubSpot connect error:', err)
    return NextResponse.json({ error: 'Could not start the HubSpot connection. Please try again.' }, { status: 500 })
  }
}

// lib/integrations/guard.ts
//
// One authorisation path for every /api/workspace/integrations/* route, so the rules cannot drift between them:
//   401 not signed in · 403 lacks MANAGE_WORKSPACE_SETTINGS · 402 plan does not include this integration
//   · 403 workspace is lapsed (read-only) for any change.
// Step-up (recent re-authentication) is applied by the routes that reveal or replace a secret.

import { NextResponse } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import type { SessionUser } from '@/lib/supabase/types'
import { integrationAllowed, minPlanLabel, type IntegrationKind } from './plans'

export async function requireIntegrationAdmin(
  kind: IntegrationKind, opts: { write: boolean } = { write: true },
): Promise<{ session: SessionUser } | { response: NextResponse }> {
  const session = await getSession()
  if (!session) return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'))
    return { response: NextResponse.json({ error: 'Missing permission: MANAGE_WORKSPACE_SETTINGS' }, { status: 403 }) }
  if (opts.write) {
    if (session.lapsed)
      return { response: NextResponse.json({ error: 'This workspace is read-only until it has an active subscription.' }, { status: 403 }) }
    if (!integrationAllowed(kind, session.planTier, false))
      return { response: NextResponse.json({ error: `This is available on the ${minPlanLabel(kind)} plan and above.`, code: 'plan_required' }, { status: 402 }) }
  }
  return { session }
}

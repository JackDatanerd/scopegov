export const runtime = 'nodejs'

import { randomUUID } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { integrationAllowed } from '@/lib/integrations/plans'
import { encryptSecret, integrationCryptoConfigured } from '@/lib/integrations/crypto'
import { emailFromIdToken, googleCall, revokeGoogleToken } from '@/lib/integrations/google'
import { DRIVE_FILE_SCOPE, GOOGLE_TOKEN_URL, DRIVE_FILES_URL, googleConfigured, googleRedirectUri, verifyGoogleState } from '@/lib/integrations/google-config'
import { ensureArchiveRoot } from '@/lib/integrations/drive-archive'

// Where Google sends the browser back after consent. Everything that matters is re-checked against the LIVE session: the
// signed state must be valid, unexpired, and name the same workspace and person who is signed in now. The person always
// lands on Settings -> Integrations with a short result code (no Google detail goes in the URL).
const back = (request: NextRequest, result: string) => {
  const base = (process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/+$/, '') || new URL(request.url).origin
  return NextResponse.redirect(`${base}/settings?tab=integrations&drive=${result}`)
}

const DRIVE_EVENTS = ['sow.signed', 'change_order.accepted'] as const

export async function GET(request: NextRequest) {
  try {
    const q = request.nextUrl.searchParams
    if (q.get('error')) return back(request, 'denied')

    const check = verifyGoogleState(q.get('state'))
    if (!check.ok) return back(request, check.reason === 'expired' ? 'expired' : 'failed')

    const session = await getSession()
    if (!session || session.workspaceId !== check.state.ws || session.id !== check.state.uid) return back(request, 'failed')
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS') || session.lapsed || !integrationAllowed('google_drive', session.planTier, false)) return back(request, 'forbidden')
    if (!googleConfigured() || !integrationCryptoConfigured()) return back(request, 'failed')

    const code = q.get('code'), redirectUri = googleRedirectUri()
    if (!code || !redirectUri) return back(request, 'failed')

    const res = await googleCall({ method: 'POST', url: GOOGLE_TOKEN_URL, form: {
      grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    } })
    const b = res.json
    if (res.status !== 200 || typeof b?.access_token !== 'string') { console.error('Google token exchange refused:', b?.error || `HTTP ${res.status}`); return back(request, 'failed') }
    // Google lets the person untick individual permissions on the consent screen. Without the Drive permission there is nothing to do.
    if (!String(b.scope || '').split(' ').includes(DRIVE_FILE_SCOPE)) return back(request, 'scope')
    // No refresh token = archiving would stop within the hour. (prompt=consent normally guarantees one.)
    if (typeof b.refresh_token !== 'string' || !b.refresh_token) return back(request, 'failed')
    const email = emailFromIdToken(b.id_token)

    const service = createServiceClient() as any
    const { data: existing, error: findErr } = await service.from('integration_connections')
      .select('id, config').eq('workspace_id', session.workspaceId).eq('provider', 'google_drive').maybeSingle()
    if (findErr) throw new Error(findErr.message)

    const id: string = existing?.id || randomUUID()
    const now = new Date().toISOString()
    const sameAccount = !existing?.config?.account_email || !email || existing.config.account_email === email
    const row = {
      status: 'active', display_name: email, last_error: null, last_error_at: null, updated_at: now,
      credentials_enc: encryptSecret(JSON.stringify({ refresh_token: b.refresh_token }), `${session.workspaceId}:${id}`),
      config: { account_email: email, scope: b.scope },
    }
    if (existing) {
      const { error } = await service.from('integration_connections').update(row).eq('id', id)
      if (error) throw new Error(error.message)
      // A DIFFERENT Google account cannot see the old account's folders or files: forget those records.
      if (!sameAccount) await service.from('integration_external_refs').delete().eq('connection_id', id)
    } else {
      const { error } = await service.from('integration_connections').insert({ id, workspace_id: session.workspaceId, provider: 'google_drive', created_by: session.id, ...row })
      if (error) throw new Error(error.message)
    }

    // Prove Drive works NOW by making (or finding) the archive folder. The commonest setup mistake — the Drive API not enabled
    // for the Google Cloud project — then shows here, on day one, instead of days later when the first contract is signed.
    const root = await ensureArchiveRoot({ service, connection: { id, workspace_id: session.workspaceId, credentials_enc: row.credentials_enc }, call: googleCall }, b.access_token)
    if ('verdict' in root) {
      console.error('Google Drive connect: could not create the archive folder:', root.verdict)
      if (!existing) await service.from('integration_connections').delete().eq('id', id)
      await revokeGoogleToken(b.refresh_token, googleCall)
      return back(request, 'api')
    }

    // The single archive rule. Created with the events this person may see; an admin can change them afterwards.
    const mine = DRIVE_EVENTS.filter(e => hasPermission(session, e === 'sow.signed' ? 'SEND_SOW' : 'SEND_CHANGE_ORDERS'))
    const { data: rule } = await service.from('integration_subscriptions').select('id').eq('connection_id', id).eq('kind', 'google_drive').maybeSingle()
    if (!rule) {
      const { error } = await service.from('integration_subscriptions').insert({
        workspace_id: session.workspaceId, connection_id: id, kind: 'google_drive', name: 'Google Drive archive', target_url: DRIVE_FILES_URL,
        event_types: mine, secret_enc: null, created_by: session.id, config: {},
      })
      if (error && (error as any).code !== '23505') throw new Error(error.message)
    } else {
      // Reconnecting switches the rule back on if (and only if) a dead token was why it was off.
      await service.from('integration_subscriptions').update({ active: true, disabled_reason: null, consecutive_failures: 0 })
        .eq('id', rule.id).like('disabled_reason', 'Google Drive needs to be reconnected%')
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.google_drive_connected', entityType: 'integration_connection', entityId: id, entityName: email || 'Google Drive',
      metadata: { reconnect: !!existing, same_account: sameAccount },
    })
    return back(request, 'connected')
  } catch (err) {
    console.error('Google Drive callback error:', err)
    return back(request, 'failed')
  }
}

export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { requireIntegrationAdmin } from '@/lib/integrations/guard'
import { loadSlackConnection, slackAs } from '@/lib/integrations/slack-connection'

// The channels a rule can post to. Public channels the app can post to without joining (chat:write.public), and private
// channels it has been invited to (Slack only lists those). At most 1000, alphabetical.
export async function GET() {
  try {
    const auth = await requireIntegrationAdmin('slack')
    if ('response' in auth) return auth.response
    const service = createServiceClient() as any
    const conn = await loadSlackConnection(service, auth.session.workspaceId)
    if (!conn || conn.status !== 'active') return NextResponse.json({ error: 'Slack is not connected.', reconnect: conn?.status === 'error' }, { status: 409 })

    const channels: Array<{ id: string; name: string; is_private: boolean; is_member: boolean }> = []
    let cursor = ''
    for (let page = 0; page < 5; page++) {
      const r = await slackAs(service, conn, 'conversations.list', { types: 'public_channel,private_channel', exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) })
      if (!r.ok) return NextResponse.json({ error: r.error, reconnect: r.reconnect }, { status: r.reconnect ? 409 : 502 })
      for (const c of r.body.channels || []) channels.push({ id: c.id, name: c.name, is_private: !!c.is_private, is_member: !!c.is_member })
      cursor = r.body.response_metadata?.next_cursor || ''
      if (!cursor) break
    }
    channels.sort((a, b) => a.name.localeCompare(b.name))
    return NextResponse.json({ channels })
  } catch (err) {
    console.error('Slack channels error:', err)
    return NextResponse.json({ error: 'Could not load Slack channels. Please try again.' }, { status: 500 })
  }
}

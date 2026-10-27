export const runtime = 'nodejs'

import { NextResponse, type NextRequest } from 'next/server'
import { withApiKey } from '@/lib/integrations/api-route'
import { isUuidString } from '@/lib/utils/uuid'

// Zapier "unsubscribe". Idempotent and scoped: it only ever removes a Zapier hook belonging to the key's own
// workspace, and answers 200 whether or not it was still there (Zapier treats an error here as a stuck Zap).
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const gate = await withApiKey(request)
    if ('response' in gate) return gate.response
    const { id } = await params
    if (isUuidString(id)) {
      const { error } = await gate.service.from('integration_subscriptions').delete()
        .eq('id', id).eq('workspace_id', gate.auth.workspaceId).eq('kind', 'zapier')
      if (error) throw new Error(error.message)
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Zapier unsubscribe error:', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

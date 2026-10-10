// app/api/clients/[id]/signatory/route.ts
//
// What the app already knows about who contracts for this client: the company on the client record, and the position the agreement
// last named for this contact. The new-project wizard reads it when a client is picked, so a repeat client is not asked again and a
// new one is asked once, before anything is drafted. Read-only; same permission the wizard itself needs.

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { isUuidString } from '@/lib/utils/uuid'
import { pickSignatoryTitle } from '@/lib/sow/signatory'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'CREATE_PROJECTS')) return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    if (!isUuidString(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const service = createServiceClient()
    const { data: client, error: clientErr } = await (service as any)
      .from('clients').select('id, name, company_name')
      .eq('id', id).eq('workspace_id', session.workspaceId).maybeSingle()
    if (clientErr) throw new Error(clientErr.message)
    if (!client) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const { data: projects, error: projErr } = await (service as any)
      .from('projects').select('id').eq('client_id', id).eq('workspace_id', session.workspaceId).limit(100)
    if (projErr) throw new Error(projErr.message)
    const ids = (projects || []).map((p: any) => p.id)

    let title = ''
    if (ids.length > 0) {
      const { data: sows, error: sowErr } = await (service as any)
        .from('sow_documents').select('metadata').in('project_id', ids).eq('workspace_id', session.workspaceId)
        .order('created_at', { ascending: false }).limit(20)
      if (sowErr) throw new Error(sowErr.message)
      title = pickSignatoryTitle(client.name, sows || [])
    }
    return NextResponse.json({ company: client.company_name || '', representative: client.name, title })
  } catch (err) {
    console.error('client signatory error:', err)
    return NextResponse.json({ error: 'Could not load the signatory details' }, { status: 500 })
  }
}

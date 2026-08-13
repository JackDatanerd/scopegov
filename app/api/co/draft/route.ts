// app/api/co/draft/route.ts
export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { stripAndParse } from '@/lib/utils/format'
import { canReadProject } from '@/lib/utils/project-access'
import { checkAiRateLimit, recordAiUsage } from '@/lib/utils/rate-limit'
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'CREATE_CHANGE_ORDERS'))
      return NextResponse.json({ error: 'Missing permission: CREATE_CHANGE_ORDERS' }, { status: 403 })

    const { projectId, request: askText } = await request.json()
    if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 })
    if (!askText?.trim()) return NextResponse.json({ error: 'Describe what the client is asking for' }, { status: 400 })

    const service = createServiceClient()

    const { data: project } = await (service as any)
      .from('projects')
      .select(`id, name, type, contract_value, currency, workspace_id,
        project_scope_snapshot(deliverables, out_of_scope)`)
      .eq('id', projectId).eq('workspace_id', session.workspaceId).single()

    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // FIX (audit round 3): no rate limiting existed on this route.
    const limited = await checkAiRateLimit(service, session.id, 'co.draft')
    if (!limited.allowed) return NextResponse.json({ error: limited.message }, { status: 429 })

    const snapshot     = project.project_scope_snapshot
    const inScope       = (snapshot?.deliverables || []).map((d: any) => d.title || d).join(', ') || 'not specified'
    const outOfScope    = (snapshot?.out_of_scope || []).map((d: any) => d.title || d).join(', ') || 'not specified'

    const prompt = `You are drafting a change order (extra billable work outside the original scope) for a client project. Return ONLY valid JSON, no markdown fences, no explanation.

Project: ${project.name} (${project.type})
Original contract value: ${project.currency} ${project.contract_value}
Already in scope (do NOT re-bill these): ${inScope}
Already excluded from scope: ${outOfScope}

The agency describes the extra work the client is asking for:
"""
${askText.slice(0, 3000)}
"""

Return this exact JSON structure:
{
  "title": "short title for this change order, e.g. 'Additional homepage redesign'",
  "note": "1-2 sentence description of the change order for the client, professional tone",
  "lineItems": [
    { "description": "specific billable item", "quantity": 1, "rate": 0 }
  ]
}

Rules:
- Break the work into 1-4 clear, specific line items — not one vague catch-all line.
- Set "rate" to 0 for every line item. Never invent a dollar amount — the agency will price each line themselves. This is non-negotiable: pricing must come from the agency, not be guessed.
- Only include work that is genuinely NOT already covered by "Already in scope" above.
- quantity should reflect a sensible unit (e.g. hours, pages, revisions) — default to 1 if unclear.
- Keep the title and note client-facing and professional — no internal jargon.`

    const msg = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages:   [{ role: 'user', content: prompt }],
    })

    const raw = msg.content.filter(b => b.type === 'text').map((b: any) => b.text).join('')

    let parsed: { title: string; note: string; lineItems: Array<{ description: string; quantity: number; rate: number }> }
    try {
      parsed = stripAndParse(raw)
    } catch {
      console.error('CO draft JSON parse failed:', raw.slice(0, 500))
      return NextResponse.json({ error: 'AI returned an unusable draft. Please try again or write it manually.' }, { status: 500 })
    }

    // Defensive: force every rate to 0 regardless of what the model returned —
    // pricing must always come from the agency, never be silently invented.
    const lineItems = (parsed.lineItems || []).map(l => ({ ...l, rate: 0 }))

    await recordAiUsage(service, session.workspaceId, session.id, 'co.draft')
    return NextResponse.json({ title: parsed.title || '', note: parsed.note || '', lineItems })
  } catch (err) {
    console.error('CO draft error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}

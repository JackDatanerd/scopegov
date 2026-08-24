// app/api/invoices/draft/route.ts
//
// FIX (doc-quality follow-up, Aug 2026): SOW and CO both have an
// AI-draft-then-revise flow; Invoice never did, even before this session's
// itemization work. Now that an invoice can carry multiple lines (fixed
// fee + T&M + reimbursable, per the Meridian sample), a blank agency
// typing four rows from scratch is exactly the kind of busywork the CO
// draft flow already exists to remove. Mirrors app/api/co/draft/route.ts
// closely on purpose — same non-negotiable rule that pricing/rate is
// always forced to 0 server-side regardless of what the model returns,
// since inventing a dollar figure on an invoice is a much worse failure
// mode than on a change order draft.
export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { stripAndParse } from '@/lib/utils/format'
import { canReadProject } from '@/lib/utils/project-access'
import { checkAiRateLimit, recordAiUsage } from '@/lib/utils/rate-limit'
import Anthropic from '@anthropic-ai/sdk'

let _client: Anthropic | null = null
function anthropicClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SEND_INVOICES'))
      return NextResponse.json({ error: 'Missing permission: SEND_INVOICES' }, { status: 403 })

    // sourceLabel is optional context from the modal about what's already
    // been picked ("Bill against" — a milestone/SOW/CO name and amount) so
    // the draft doesn't ignore a source the agency already selected.
    const { projectId, request: askText, sourceLabel } = await request.json()
    if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 })
    if (!askText?.trim()) return NextResponse.json({ error: 'Describe what this invoice covers' }, { status: 400 })

    const service = createServiceClient()

    const { data: project } = await (service as any)
      .from('projects')
      .select('id, name, type, currency, workspace_id')
      .eq('id', projectId).eq('workspace_id', session.workspaceId).single()

    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const limited = await checkAiRateLimit(service, session.id, 'invoice.draft')
    if (!limited.allowed) return NextResponse.json({ error: limited.message }, { status: 429 })

    const prompt = `You are drafting a client invoice for billable work already completed. Return ONLY valid JSON, no markdown fences, no explanation.

Project: ${project.name} (${project.type})
Currency: ${project.currency}
${sourceLabel ? `This invoice bills against: ${sourceLabel}` : 'No specific milestone/SOW/CO selected — this is a standalone invoice.'}

The agency describes what's being billed:
"""
${askText.slice(0, 3000)}
"""

Return this exact JSON structure:
{
  "title": "short invoice title, e.g. 'Fleet Rollout — Wave 2 completion'",
  "lineItems": [
    { "description": "specific billable line item", "quantity": 1, "rate": 0 }
  ]
}

Rules:
- Break the work into separate line items whenever it spans different billing bases — a fixed-fee milestone, hourly time-and-materials hours, and a reimbursable expense are three different lines, not one. If it's genuinely a single flat charge, one line item is fine.
- Set "rate" to 0 for every line item. Never invent a dollar amount or an hourly rate — the agency prices each line themselves. This is non-negotiable.
- quantity should reflect a sensible unit (hours for T&M, 1 for a fixed-fee milestone or a flat expense reimbursement) — default to 1 if unclear.
- Keep the title client-facing and professional — no internal jargon, no placeholder text like "TBD".`

    const msg = await anthropicClient().messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages:   [{ role: 'user', content: prompt }],
    })

    const raw = msg.content.filter(b => b.type === 'text').map((b: any) => b.text).join('')

    let parsed: { title: string; lineItems: Array<{ description: string; quantity: number; rate: number }> }
    try {
      parsed = stripAndParse(raw)
    } catch {
      console.error('Invoice draft JSON parse failed:', raw.slice(0, 500))
      return NextResponse.json({ error: 'AI returned an unusable draft. Please try again or write it manually.' }, { status: 500 })
    }

    // Defensive: force every rate to 0 regardless of what the model
    // returned — same rule as CO drafting, pricing must always come from
    // the agency, never be silently invented on a client-facing invoice.
    const lineItems = (parsed.lineItems || []).map(l => ({ ...l, rate: 0 }))

    await recordAiUsage(service, session.workspaceId, session.id, 'invoice.draft')
    return NextResponse.json({ title: parsed.title || '', lineItems })
  } catch (err) {
    console.error('Invoice draft error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}

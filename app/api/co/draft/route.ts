// app/api/co/draft/route.ts
export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { canReadProject } from '@/lib/utils/project-access'
import { checkAiRateLimit, recordAiUsage } from '@/lib/utils/rate-limit'
import Anthropic from '@anthropic-ai/sdk'

// Forced tool call instead of "return only JSON" + string parsing (BUG-027's
// stripAndParse route): a schema the model MUST fill in is reliable in a way
// free-text JSON never fully is — no fence-stripping, no occasional stray
// prose before/after the object, no missing-field guessing on our end.
const DRAFT_CO_TOOL = {
  name: 'draft_change_order',
  description: 'Draft a change order (extra billable work outside the original scope) for a client project.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: {
        type: 'string',
        description: "Short, client-facing title, e.g. 'Additional homepage redesign'.",
      },
      note: {
        type: 'string',
        description: '1-2 sentence client-facing description of the change order. Professional tone, no internal jargon.',
      },
      scopeImpact: {
        type: 'string',
        description: 'One sentence on how this work sits outside the signed scope — shown to the client as its own line in Impact Analysis. Reference the specific deliverable or SOW section this falls outside of. Omit only if there is genuinely nothing beyond the note worth saying.',
      },
      timelineImpactDays: {
        type: ['integer', 'null'],
        description: 'Net day shift to the project timeline this change order introduces, signed (e.g. 5, -2). Null if there is no clear timeline effect — never guess a number to fill the field.',
      },
      lineItems: {
        type: 'array',
        minItems: 1,
        maxItems: 6,
        items: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'A specific, billable line — not a vague catch-all.' },
            quantity:    { type: 'number', description: 'Sensible unit count (hours, pages, revisions). Default 1 if unclear.' },
          },
          required: ['description', 'quantity'],
        },
      },
    },
    required: ['title', 'note', 'lineItems'],
  },
}

// FIX (re-audit — build-blocking): was constructed at module scope, so an
// unset ANTHROPIC_API_KEY turns importing this route into a hard build
// failure instead of a runtime error. Lazy singleton, same fix as
// lib/email/templates.ts and lib/ai/guardian.ts.
let _client: Anthropic | null = null
function anthropicClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'CREATE_CHANGE_ORDERS'))
      return NextResponse.json({ error: 'Missing permission: CREATE_CHANGE_ORDERS' }, { status: 403 })

    const { projectId, request: askText, flagId } = await request.json()
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

    // Optional: grounding from the Guardian flag this draft is for, so the
    // model isn't working from the agency's paraphrase alone. Scoped to
    // this project + workspace — flagId is client-supplied.
    let flagContext = ''
    if (flagId) {
      const { data: flag } = await (service as any)
        .from('guardian_flags')
        .select('description,severity,sow_reference,project_id')
        .eq('id', flagId).eq('workspace_id', session.workspaceId).single()
      if (flag && flag.project_id === projectId) {
        flagContext = `\nThis originates from a Guardian scope flag:
Flag severity: ${flag.severity}
SOW reference this exceeds: ${flag.sow_reference}
Flag description (agency's summary, not the client's own words): ${flag.description}\n`
      }
    }

    // FIX (audit round 3): no rate limiting existed on this route.
    const limited = await checkAiRateLimit(service, session.id, 'co.draft')
    if (!limited.allowed) return NextResponse.json({ error: limited.message }, { status: 429 })

    const snapshot     = project.project_scope_snapshot
    const inScope       = (snapshot?.deliverables || []).map((d: any) => d.title || d).join(', ') || 'not specified'
    const outOfScope    = (snapshot?.out_of_scope || []).map((d: any) => d.title || d).join(', ') || 'not specified'

    const prompt = `You are drafting a change order (extra billable work outside the original scope) for a client project.

Project: ${project.name} (${project.type})
Original contract value: ${project.currency} ${project.contract_value}
Already in scope (do NOT re-bill these): ${inScope}
Already excluded from scope: ${outOfScope}
${flagContext}
The agency describes the extra work the client is asking for:
"""
${askText.slice(0, 3000)}
"""

Rules:
- Break the work into 1-4 clear, specific line items — not one vague catch-all line.
- Never set a dollar rate. Pricing always comes from the agency, not the model.
- Only include work that is genuinely NOT already covered by "Already in scope" above.
- quantity should reflect a sensible unit (e.g. hours, pages, revisions) — default to 1 if unclear.
- Keep title and note client-facing and professional — no internal jargon.
- scopeImpact should name the specific deliverable or SOW section this falls outside of, not just restate the note.`

    const msg = await anthropicClient().messages.create({
      model:       'claude-haiku-4-5-20251001',
      max_tokens:  1200,
      tools:       [DRAFT_CO_TOOL],
      tool_choice: { type: 'tool', name: 'draft_change_order' },
      messages:    [{ role: 'user', content: prompt }],
    })

    const toolUse = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    if (!toolUse) {
      console.error('CO draft: no tool_use block in response', msg.stop_reason)
      return NextResponse.json({ error: 'AI returned an unusable draft. Please try again or write it manually.' }, { status: 500 })
    }

    const parsed = toolUse.input as {
      title: string; note: string; scopeImpact?: string | null
      timelineImpactDays?: number | null
      lineItems: Array<{ description: string; quantity: number }>
    }

    // Defensive: force every rate to 0 regardless of what the model returned —
    // pricing must always come from the agency, never be silently invented.
    const lineItems = (parsed.lineItems || []).map(l => ({ ...l, rate: 0 }))

    await recordAiUsage(service, session.workspaceId, session.id, 'co.draft')
    return NextResponse.json({
      title:              parsed.title || '',
      note:               parsed.note || '',
      scopeImpact:        parsed.scopeImpact || null,
      timelineImpactDays: typeof parsed.timelineImpactDays === 'number' ? parsed.timelineImpactDays : null,
      lineItems,
    })
  } catch (err) {
    console.error('CO draft error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}

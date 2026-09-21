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
import { canReadProject } from '@/lib/utils/project-access'
import { checkAiRateLimit, recordAiUsage } from '@/lib/utils/rate-limit'
import Anthropic from '@anthropic-ai/sdk'

let _client: Anthropic | null = null
function anthropicClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

// Forced tool call instead of "return only JSON" + stripAndParse — matches
// the fix applied to app/api/co/draft/route.ts on the same reliability
// grounds: a schema the model must fill in doesn't fail on stray prose or
// a missed fence the way free-text JSON occasionally did.
const DRAFT_INVOICE_TOOL = {
  name: 'draft_invoice',
  description: 'Draft a client invoice for billable work already completed.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: {
        type: 'string',
        description: "Short, client-facing invoice title, e.g. 'Fleet Rollout — Wave 2 completion'. No placeholder text like 'TBD'.",
      },
      lineItems: {
        type: 'array',
        minItems: 1,
        maxItems: 6,
        items: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'A specific billable line item.' },
            quantity:    { type: 'number', description: 'Sensible unit (hours for T&M, 1 for a fixed-fee milestone or flat expense). Default 1 if unclear.' },
          },
          required: ['description', 'quantity'],
        },
      },
    },
    required: ['title', 'lineItems'],
  },
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
    // sourceContext (FIX, invoice-convenience audit) carries the picked
    // milestone's own billingType/trigger/notes — structured data the
    // milestone already had on file, so the model can tell a fixed-fee
    // milestone apart from an hourly_cap/retainer one instead of guessing
    // purely from prose the agency retyped.
    const reqBody = await request.json().catch(() => null)
    if (!reqBody || typeof reqBody !== 'object' || Array.isArray(reqBody))
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    const { projectId, request: askText } = reqBody
    // FIX (section-12 audit, pass 2): sourceLabel / sourceContext were client-supplied
    // and interpolated into the model prompt with no type or length limit (an
    // unbounded prompt, and a route for stuffing arbitrary instructions into it).
    // Only the fields the modal actually sends are read, coerced to short strings.
    const clip = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
    const sourceLabel = clip(reqBody.sourceLabel, 200)
    const rawCtx = reqBody.sourceContext && typeof reqBody.sourceContext === 'object' ? reqBody.sourceContext : {}
    const sourceContext = {
      billingType: clip(rawCtx.billingType, 40),
      trigger: clip(rawCtx.trigger, 300),
      notes: clip(rawCtx.notes, 500),
    }
    if (typeof projectId !== 'string' || !projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 })
    if (typeof askText !== 'string' || !askText.trim()) return NextResponse.json({ error: 'Describe what this invoice covers' }, { status: 400 })

    const service = createServiceClient()

    const { data: project } = await (service as any)
      .from('projects')
      .select('id, name, type, currency, workspace_id')
      .eq('id', projectId).eq('workspace_id', session.workspaceId).is('deleted_at', null).single()

    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const limited = await checkAiRateLimit(service, session.id, 'invoice.draft')
    if (!limited.allowed) return NextResponse.json({ error: limited.message }, { status: 429 })

    const billingTypeGuidance: Record<string, string> = {
      fixed:            'This is a flat fixed-fee milestone — one line item is normal.',
      percentage:       'This is a percentage-of-contract milestone — one line item for the percentage tranche is normal.',
      hourly_cap:       'This is hourly time-and-materials work with a cap — expect an hours line (quantity = hours worked) and possibly a separate reimbursable-expense line.',
      retainer_monthly: 'This is a monthly retainer — one recurring line item for the period is normal.',
    }

    const prompt = `You are drafting a client invoice for billable work already completed.

Project: ${project.name} (${project.type})
Currency: ${project.currency}
${sourceLabel ? `This invoice bills against: ${sourceLabel}` : 'No specific milestone/SOW/CO selected — this is a standalone invoice.'}
${sourceContext?.billingType ? billingTypeGuidance[sourceContext.billingType] || '' : ''}
${sourceContext?.trigger ? `Milestone billing trigger on file: "${sourceContext.trigger}"` : ''}
${sourceContext?.notes ? `Milestone notes on file: "${sourceContext.notes}"` : ''}

The agency describes what's being billed:
"""
${askText.slice(0, 3000)}
"""

Rules:
- Break the work into separate line items whenever it spans different billing bases — a fixed-fee milestone, hourly time-and-materials hours, and a reimbursable expense are three different lines, not one. If it's genuinely a single flat charge, one line item is fine.
- Never set a dollar rate. Pricing always comes from the agency, not the model.
- quantity should reflect a sensible unit (hours for T&M, 1 for a fixed-fee milestone or a flat expense reimbursement) — default to 1 if unclear.
- Keep the title client-facing and professional — no internal jargon, no placeholder text like "TBD".`

    const msg = await anthropicClient().messages.create({
      model:       'claude-haiku-4-5-20251001',
      max_tokens:  1000,
      tools:       [DRAFT_INVOICE_TOOL],
      tool_choice: { type: 'tool', name: 'draft_invoice' },
      messages:    [{ role: 'user', content: prompt }],
    })

    const toolUse = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    if (!toolUse) {
      console.error('Invoice draft: no tool_use block in response', msg.stop_reason)
      return NextResponse.json({ error: 'AI returned an unusable draft. Please try again or write it manually.' }, { status: 500 })
    }

    const parsed = toolUse.input as { title: string; lineItems: Array<{ description: string; quantity: number }> }

    // Defensive: force every rate to 0 regardless of what the model
    // returned — same rule as CO drafting, pricing must always come from
    // the agency, never be silently invented on a client-facing invoice.
    const lineItems = (parsed.lineItems || []).map(l => ({ ...l, rate: 0 }))

    await recordAiUsage(service, session.workspaceId, session.id, 'invoice.draft')
    return NextResponse.json({ title: parsed.title || '', lineItems })
  } catch (err) {
    console.error('Invoice draft error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

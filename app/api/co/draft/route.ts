// app/api/co/draft/route.ts
export const runtime = 'nodejs'
export const maxDuration = 60

import { MAX_DESCRIPTION_LEN } from '@/lib/documents/co-totals'
import { isRealLookupFailure } from '@/lib/documents/co-lookup'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { canReadProject } from '@/lib/utils/project-access'
import { claimAiRateSlot } from '@/lib/utils/rate-limit'
import { isTerminalStatus } from '@/lib/utils/project-status'
import Anthropic from '@anthropic-ai/sdk'
import { createWithTool } from '@/lib/ai/tool-call'
import { aiModel, structuredJobParams, scaleMaxTokens } from '@/lib/ai/model'
import { sanitizePlainText, truncateText, stripUnstorableText } from '@/lib/utils/sanitize'
import { MIN_CO_TIMELINE_DAYS, MAX_CO_TIMELINE_DAYS } from '@/lib/documents/co-input'

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

    const reqBody = await request.json().catch(() => null)
    const { projectId, request: askRaw, flagId } = (reqBody || {}) as any
    if (!projectId || typeof projectId !== 'string') return NextResponse.json({ error: 'projectId required' }, { status: 400 })
    if (typeof askRaw !== 'string' || !askRaw.trim()) return NextResponse.json({ error: 'Describe what the client is asking for' }, { status: 400 })
    if (flagId !== undefined && flagId !== null && typeof flagId !== 'string') return NextResponse.json({ error: 'flagId must be an id' }, { status: 400 })
    const askText: string = askRaw

    const service = createServiceClient()

    const { data: project, error: projectErr } = await (service as any)
      .from('projects')
      .select(`id, name, type, status, contract_value, currency, workspace_id,
        project_scope_snapshot(deliverables, out_of_scope)`)
      .eq('id', projectId).eq('workspace_id', session.workspaceId).is('deleted_at', null).single()

    if (!project) {
      if (isRealLookupFailure(projectErr)) throw new Error(`project lookup failed: ${projectErr.message}`)
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    // FIX (Projects & Dashboard deep audit): same terminal-status guard as
    // POST /api/co — no point spending an AI call drafting a change order
    // that could never be created or sent against a Complete/Archived
    // project.
    if (isTerminalStatus(project.status))
      return NextResponse.json({
        error: `This project is ${project.status.toLowerCase()} — a change order can no longer be drafted. Reopen the project first.`,
      }, { status: 409 })

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
    // FIX (CO logic, independent pass 6): the slot is CLAIMED here (insert, then count, back out if over) rather than
    // checked here and recorded after the model call. Check-then-record let a burst of parallel requests all read the same
    // under-the-limit count and all make a paid model call; see claimAiRateSlot. The slot stays used even if the call below
    // fails or returns an unusable draft — the call may still have been billed, and retries must not run past the limit.
    const limited = await claimAiRateSlot(service, session.workspaceId, session.id, 'co.draft')
    if (!limited.allowed) return NextResponse.json({ error: limited.message }, { status: 429 })

    const snapshot     = project.project_scope_snapshot
    const inScope       = (snapshot?.deliverables || []).map((d: any) => d.title || d).join(', ') || 'not specified'
    const outOfScope    = (snapshot?.out_of_scope || []).map((d: any) => d.title || d).join(', ') || 'not specified'

    // CO-7: slice(0, 3000) counts UTF-16 units, so a cut through an emoji left half a surrogate pair in the request, and
    // the pasted text was never stripped of NUL / lone surrogates - the model call then failed on invalid Unicode and the
    // user got a generic 500 for a request that looked fine (with the rate-limit slot already spent).
    const requestText = truncateText(stripUnstorableText(askText), 3000)

    const prompt = `You are drafting a change order (extra billable work outside the original scope) for a client project.

Project: ${project.name} (${project.type})
${project.type === 'retainer' ? `Billing: monthly retainer — the original value below is the MONTHLY fee.\n` : ''}Original contract value: ${project.currency} ${project.contract_value}
Already in scope (do NOT re-bill these): ${inScope}
Already excluded from scope: ${outOfScope}
${flagContext}
The agency describes the extra work the client is asking for:
"""
${requestText}
"""

Rules:
- Break the work into 1-4 clear, specific line items — not one vague catch-all line.
- Never set a dollar rate. Pricing always comes from the agency, not the model.
- Only include work that is genuinely NOT already covered by "Already in scope" above.
- quantity should reflect a sensible unit (e.g. hours, pages, revisions) — default to 1 if unclear.
- Keep title and note client-facing and professional — no internal jargon.
- Write note and scopeImpact in the third person, as a contract would: refer to "the Provider" and "the Client" and never use "we", "us", "you" or "your".
- Any quantity named in note or scopeImpact (pages, rounds, hours) must equal the line-item quantities exactly. Never write "a round" or "one" when a line item says 2. If a line item adds revision rounds, say they are in addition to any revision rounds already included in the SOW.
- Bound every line item: its description must state its limit (for example the number of creators, outreach rounds, pages or posts) so the extra work cannot grow open-ended. If the request gives no number, choose a small sensible one and state it.
- If the work is listed under "Already excluded", say in scopeImpact that this change order brings it into scope by amending that exclusion, for the described work only; every other exclusion stays.
- Costs paid to third parties (creator fees, ad spend, licences, tools) are not part of the Provider's fee unless the request says so; say who bears them in the note.
- For a retainer, say in the note whether each line is a one-time fee or recurs monthly. For an ongoing engagement with no end date, leave timelineImpactDays null unless the request names a delay.
- scopeImpact should name the specific deliverable or SOW section this falls outside of, quoting the section by its printed title (for example the "Out of Scope" section), not just restate the note.`

    // createWithTool: some models (e.g. a newer ANTHROPIC_MODEL) reject a forced tool_choice with a 400 — it retries
    // once with tool_choice 'auto' instead of failing every draft (see lib/ai/tool-call.ts).
    const model = aiModel()
    const msg = await createWithTool(anthropicClient(), {
      model,
      max_tokens:  scaleMaxTokens(model, 1200),
      ...structuredJobParams(model),
      tools:       [DRAFT_CO_TOOL],
      messages:    [{ role: 'user', content: prompt }],
    }, 'draft_change_order')

    const toolUse = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    if (!toolUse) {
      console.error('CO draft: no tool_use block in response', msg.stop_reason)
      return NextResponse.json({ error: 'AI returned an unusable draft. Please try again or write it manually.' }, { status: 500 })
    }

    const parsed = toolUse.input as {
      title: string; note: string; scopeImpact?: string | null
      // FIX (build): declared `number | null`, so the `typeof rawDays === 'string'` guard below narrowed to `never`
      // and `.trim()` failed type-checking. The model can return a string here (that is exactly what the guard is for).
      timelineImpactDays?: number | string | null
      lineItems: Array<{ description: string; quantity: number }>
    }

    // Defensive: force every rate to 0 regardless of what the model returned —
    // pricing must always come from the agency, never be silently invented.
    // Tool output is untrusted structure: clamp everything before it reaches the editor (the model can
    // return strings for numbers, negative or absurd quantities, or missing fields). Rate is always 0 —
    // pricing comes from the agency, never the model.
    const lineItems = (Array.isArray(parsed.lineItems) ? parsed.lineItems : []).slice(0, 6).map(l => {
      const q = Number(l?.quantity)
      return {
        description: truncateText(sanitizePlainText(String(l?.description ?? '')), MAX_DESCRIPTION_LEN),
        quantity: Number.isFinite(q) && q > 0 && q <= 10_000 ? q : 1,
        rate: 0,
      }
    }).filter(l => l.description)
    // FIX (CO logic, independent pass 6): a draft with a title and note but no usable line items was returned as a success.
    // The editor then replaced the user's title/note/impact fields and — having nothing to put in them — silently kept
    // their OLD line items, leaving a half-applied draft whose lines no longer matched its own title (and a confirm
    // dialog that had promised everything would be replaced). A change order with no work lines is not a usable draft
    // (the tool schema requires them; this is the model ignoring it or every line failing sanitization), so say so.
    if (lineItems.length === 0) {
      console.error('CO draft: model returned no usable line items', msg.stop_reason)
      return NextResponse.json({ error: 'AI could not break that into line items. Add more detail about the work, or write it manually.' }, { status: 422 })
    }
    // The tool schema tells the model to return null when it can't tell. Number(null) is 0, which would pass the
    // integer check and turn "unknown" into a "0 days — no change to the timeline" claim to the client, so null /
    // undefined / blank are mapped to null before any coercion.
    const rawDays = parsed.timelineImpactDays
    const days = rawDays === null || rawDays === undefined || (typeof rawDays === 'string' && rawDays.trim() === '') ? NaN : Number(rawDays)

    return NextResponse.json({
      title:              truncateText(sanitizePlainText(String(parsed.title ?? '')), 200),
      note:               truncateText(sanitizePlainText(String(parsed.note ?? '')), 2000),
      scopeImpact:        parsed.scopeImpact ? truncateText(sanitizePlainText(String(parsed.scopeImpact)), 1000) : null,
      timelineImpactDays: Number.isInteger(days) && days >= MIN_CO_TIMELINE_DAYS && days <= MAX_CO_TIMELINE_DAYS ? days : null,
      lineItems,
    })
  } catch (err) {
    console.error('CO draft error:', err)
    return NextResponse.json({ error: 'Could not draft the change order. Please try again or write it manually.' }, { status: 500 })
  }
}

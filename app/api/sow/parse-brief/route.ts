export const runtime = 'nodejs'
export const maxDuration = 60

import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { stripAndParse } from '@/lib/utils/format'
import { truncateText } from '@/lib/utils/sanitize'
import { claimAiRateSlot } from '@/lib/utils/rate-limit'
import { createServiceClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'
import { aiModel, structuredJobParams, scaleMaxTokens } from '@/lib/ai/model'

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
    // FIX (re-audit): sibling routes (generate, regenerate-section) both
    // require EDIT_SOW — this one didn't, letting anyone with a session
    // (including a read-only member) spend the AI rate-limit budget with
    // no ability to actually use the result.
    if (!hasPermission(session, 'EDIT_SOW'))
      return NextResponse.json({ error: 'Missing permission: EDIT_SOW' }, { status: 403 })

    const reqBody = await request.json().catch(() => null)
    const briefText   = typeof reqBody?.briefText === 'string' ? reqBody.briefText : ''
    const projectType = typeof reqBody?.projectType === 'string' ? truncateText(reqBody.projectType, 120) : undefined
    if (!briefText.trim()) return NextResponse.json({ error: 'briefText required' }, { status: 400 })

    // FIX (audit round 3): no rate limiting existed on this or any other
    // AI-cost route. See lib/utils/rate-limit.ts.
    const service = createServiceClient()
    // FIX (SOW lifecycle pass 23, B1): the slot is CLAIMED here (insert, count, back out if over) instead of checked here and
    // recorded after the model call. Check-then-record let a burst of parallel requests all read the same under-the-limit
    // count and all make paid calls (generate: up to 3 each); a call that threw after being billed was never counted at all.
    // Same fix co/draft and guardian/check already have; see claimAiRateSlot. The slot stays used even if the call fails.
    const limited = await claimAiRateSlot(service, session.workspaceId, session.id, 'sow.parseBrief')
    if (!limited.allowed) return NextResponse.json({ error: limited.message }, { status: 429 })

    // Carry-forward §1.4: Haiku for brief parsing — fast, reliable extraction
    const prompt = `Extract structured scope information from this text. Return ONLY valid JSON, no markdown fences, no explanation.

Text:
"""
${truncateText(briefText, 8000)}
"""

Project type context: ${projectType || 'not specified'}

Return this exact JSON structure with extracted values:
{
  "objective": "what is this project trying to achieve (1-2 sentences)",
  "deliverables": "bullet list of deliverables, one per line starting with -",
  "outOfScope": "bullet list of explicitly excluded items, one per line starting with -",
  "timeline": "duration or deadline if mentioned, else empty string",
  "paymentStructure": "one of: 50_50 | 100_upfront | milestones | monthly | on_delivery — infer from context or default 50_50",
  "revisionRounds": 2
}

Rules:
- Extract only what is actually stated. Do not invent deliverables.
- If a field cannot be inferred, use an empty string (not null).
- revisionRounds must be an integer between 1 and 5. Default 2 if not mentioned.
- Never invent payment amounts or deadlines.`

    const model = aiModel()
    const msg = await anthropicClient().messages.create({
      model,
      max_tokens: scaleMaxTokens(model, 3000),
      ...structuredJobParams(model),
      messages:   [{ role: 'user', content: prompt }],
    })

    // (Usage is counted by the slot claimed before the call above, so a malformed or cut-off reply is never a free retry.)
    const raw = msg.content.filter(b => b.type === 'text').map((b: any) => b.text).join('')

    // FIX (SOW lifecycle independent pass 15, B3): a reply cut off at max_tokens is incomplete JSON; say so instead of a
    // generic parse failure.
    if (msg.stop_reason === 'max_tokens')
      return NextResponse.json({ error: 'That brief is too long to read in one go. Shorten it or split it, then try again.' }, { status: 422 })
    const parsed = stripAndParse<Record<string, unknown>>(raw)
    // SOW lifecycle pass 17, B2: the model's JSON shape is not trusted. A list (instead of the requested newline
    // string) in a text field reached the form as an array and was then dropped by generate's string-only cap.
    const text = (v: unknown): string => {
      if (typeof v === 'string') return v
      if (Array.isArray(v)) return v.filter(x => typeof x === 'string' && x.trim()).map(x => `- ${String(x).replace(/^[-*]\s*/, '')}`).join('\n')
      return ''
    }
    const brief = {
      objective: text(parsed?.objective), deliverables: text(parsed?.deliverables),
      outOfScope: text(parsed?.outOfScope), timeline: text(parsed?.timeline),
      paymentStructure: typeof parsed?.paymentStructure === 'string' ? parsed.paymentStructure : '',
      revisionRounds: Number(parsed?.revisionRounds),
    }
    return NextResponse.json({ brief })
  } catch (err) {
    console.error('Brief parse error:', err)
    return NextResponse.json({ error: 'Failed to parse brief' }, { status: 500 })
  }
}

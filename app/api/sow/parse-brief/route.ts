export const runtime = 'nodejs'

import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { stripAndParse } from '@/lib/utils/format'
import { checkAiRateLimit, recordAiUsage } from '@/lib/utils/rate-limit'
import { createServiceClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'

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

    const { briefText, projectType } = await request.json()
    if (!briefText?.trim()) return NextResponse.json({ error: 'briefText required' }, { status: 400 })

    // FIX (audit round 3): no rate limiting existed on this or any other
    // AI-cost route. See lib/utils/rate-limit.ts.
    const service = createServiceClient()
    const limited = await checkAiRateLimit(service, session.id, 'sow.parseBrief')
    if (!limited.allowed) return NextResponse.json({ error: limited.message }, { status: 429 })

    // Carry-forward §1.4: Haiku for brief parsing — fast, reliable extraction
    const prompt = `Extract structured scope information from this text. Return ONLY valid JSON, no markdown fences, no explanation.

Text:
"""
${briefText.slice(0, 8000)}
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

    const msg = await anthropicClient().messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages:   [{ role: 'user', content: prompt }],
    })

    // FIX (SOW lifecycle re-audit): this used to record usage AFTER
    // stripAndParse — so a call that reached the model (the actual cost,
    // and the thing checkAiRateLimit exists to bound) but then failed to
    // parse as JSON never counted against the rate limit at all. Record
    // the instant a real response comes back, before anything that can
    // throw on this call's behalf, so a string of malformed replies can't
    // be retried past the limit for free.
    const raw = msg.content.filter(b => b.type === 'text').map((b: any) => b.text).join('')
    await recordAiUsage(service, session.workspaceId, session.id, 'sow.parseBrief')

    const brief = stripAndParse<Record<string, unknown>>(raw)
    return NextResponse.json({ brief })
  } catch (err) {
    console.error('Brief parse error:', err)
    return NextResponse.json({ error: 'Failed to parse brief' }, { status: 500 })
  }
}

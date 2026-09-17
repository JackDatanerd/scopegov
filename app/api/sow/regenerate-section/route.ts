export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { stripAndParse, stripHtml, countWords } from '@/lib/utils/format'
import { sanitizeRichText } from '@/lib/utils/sanitize'
import { canReadProject } from '@/lib/utils/project-access'
import { checkAiRateLimit, recordAiUsage } from '@/lib/utils/rate-limit'
import { getPendingApprovalForDocument } from '@/lib/approvals/engine'
import { AI_SECTION_IDS } from '@/lib/ai/sow-content'
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
    if (!hasPermission(session, 'EDIT_SOW'))
      return NextResponse.json({ error: 'Missing permission: EDIT_SOW' }, { status: 403 })

    const { sowId, sectionId, sectionTitle, currentContent, instruction, projectContext } = await request.json()

    // FIX (section-9 re-pass): sectionId was never checked against
    // anything — a request for a table-only section id (deliverables,
    // timeline, roles, payment_schedule) would still spend a model call
    // and return prose, even though that section's `content` field is
    // never rendered anywhere (the PDF and portal both only read its
    // `table`). Harmless today, but silently wastes a call for no
    // visible effect and masks what should be a client-side bug.
    if (!AI_SECTION_IDS.includes(sectionId)) {
      return NextResponse.json({ error: 'That section cannot be regenerated with AI' }, { status: 400 })
    }

    const service = createServiceClient()
    const { data: sow } = await (service as any)
      .from('sow_documents').select('id, sent_at, project_id').eq('id', sowId)
      .eq('workspace_id', session.workspaceId).single()

    if (!sow) return NextResponse.json({ error: 'SOW not found' }, { status: 404 })
    if (!(await canReadProject(service, session, sow.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (sow.sent_at) return NextResponse.json({ error: 'SOW is locked' }, { status: 409 })

    // FIX (section-9 audit, 9-B15): PATCH /api/sow/[id] and
    // /api/sow/generate both refuse to touch a draft with an approval
    // decision outstanding; this route didn't. It doesn't write, so it was
    // never a gate bypass — but it would happily spend the workspace's AI
    // budget rewriting a document that is frozen, and hand back content
    // the subsequent save is guaranteed to reject with a confusing
    // "Save failed". Fail fast with the real reason instead.
    if (await getPendingApprovalForDocument(service, 'sow', sowId)) {
      return NextResponse.json(
        { error: 'This SOW has a pending approval request — cancel it before editing.' },
        { status: 409 }
      )
    }

    // FIX (audit round 3): no rate limiting existed on this route.
    const limited = await checkAiRateLimit(service, session.id, 'sow.regenerateSection')
    if (!limited.allowed) return NextResponse.json({ error: limited.message }, { status: 429 })

    // BUG-032: hard word ceiling — never grow beyond current length
    const currentWords = countWords(currentContent || '')
    const wordLimit    = Math.max(currentWords, 60) // no +20 growth, min 60

    const prompt = `You are rewriting one section of a professional Statement of Work.

Section: ${sectionTitle}
${projectContext ? `Project context: ${projectContext}` : ''}
${instruction ? `Instruction: ${instruction}` : 'Improve clarity and professionalism.'}

Current content (plain text for reference):
${stripHtml(currentContent || '').slice(0, 800)}

HARD LIMIT: ${wordLimit} words maximum. Do NOT exceed this under any circumstances.
If you cannot improve within the word limit, return the current version verbatim.

Return ONLY the new section content as valid HTML (use <p>, <ul>, <li>, <strong>).
No preamble, no explanation, no markdown fences. Just the HTML content.`

    const msg = await anthropicClient().messages.create({
      model:       'claude-haiku-4-5-20251001',
      max_tokens:  600,                            // BUG-032: 600 not 800
      messages:    [{ role: 'user', content: prompt }],
    })

    let raw = msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')

    // Strip any accidental markdown fences
    raw = raw.replace(/^```html?\s*/i, '').replace(/\s*```$/i, '').trim()

    // Validate it's not empty
    if (!raw || stripHtml(raw).length < 10) {
      return NextResponse.json({ error: 'Regeneration produced empty content' }, { status: 500 })
    }

    // Enforce word limit
    // FIX (re-audit): this used to only log a warning on overflow and
    // still return the oversized content — "HARD LIMIT" in the prompt
    // above was advisory only, not actually enforced. A section is meant
    // to never grow past its current length (BUG-032), and the model
    // does occasionally ignore the instruction. Truncating the raw HTML
    // string at a word boundary risks leaving an unclosed tag (a stray
    // <strong> or <li> with no close), which is worse than just being
    // over budget — sanitizeRichText() doesn't repair malformed markup,
    // it removes disallowed tags/attributes. So on overflow, don't try
    // to salvage the AI's output at all: fall back to the section's
    // current content, which is already valid, already sanitized once
    // (see PATCH /api/sow/[id]), and by definition respects the limit.
    const newWords = countWords(raw)
    if (newWords > wordLimit * 1.1) {
      console.warn(`Section regeneration exceeded word limit (${newWords} > ${wordLimit}) — falling back to current content`)
      await recordAiUsage(service, session.workspaceId, session.id, 'sow.regenerateSection')
      return NextResponse.json({
        content: sanitizeRichText(currentContent || ''),
        wordCount: currentWords,
        truncated: true,
      })
    }

    await recordAiUsage(service, session.workspaceId, session.id, 'sow.regenerateSection')
    return NextResponse.json({ content: sanitizeRichText(raw), wordCount: newWords })
  } catch (err) {
    console.error('Section regeneration error:', err)
    return NextResponse.json({ error: 'Regeneration failed. Please try again.' }, { status: 500 })
  }
}

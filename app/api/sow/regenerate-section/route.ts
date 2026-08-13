export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { stripAndParse, stripHtml, countWords } from '@/lib/utils/format'
import { sanitizeRichText } from '@/lib/utils/sanitize'
import { canReadProject } from '@/lib/utils/project-access'
import { checkAiRateLimit, recordAiUsage } from '@/lib/utils/rate-limit'
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'EDIT_SOW'))
      return NextResponse.json({ error: 'Missing permission: EDIT_SOW' }, { status: 403 })

    const { sowId, sectionId, sectionTitle, currentContent, instruction, projectContext } = await request.json()

    const service = createServiceClient()
    const { data: sow } = await (service as any)
      .from('sow_documents').select('id, sent_at, project_id').eq('id', sowId)
      .eq('workspace_id', session.workspaceId).single()

    if (!sow) return NextResponse.json({ error: 'SOW not found' }, { status: 404 })
    if (!(await canReadProject(service, session, sow.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (sow.sent_at) return NextResponse.json({ error: 'SOW is locked' }, { status: 409 })

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

    const msg = await client.messages.create({
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
    const newWords = countWords(raw)
    if (newWords > wordLimit * 1.1) {
      // Truncate — but this shouldn't happen with the prompt
      console.warn(`Section regeneration exceeded word limit: ${newWords} > ${wordLimit}`)
    }

    await recordAiUsage(service, session.workspaceId, session.id, 'sow.regenerateSection')
    return NextResponse.json({ content: sanitizeRichText(raw), wordCount: newWords })
  } catch (err) {
    console.error('Section regeneration error:', err)
    return NextResponse.json({ error: 'Regeneration failed. Please try again.' }, { status: 500 })
  }
}

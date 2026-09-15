export const runtime = 'nodejs'
// FIX: no explicit maxDuration was set, so this route ran under Vercel's
// platform default (as low as 10s on some plans) — generating a full SOW
// can legitimately take longer than that, especially with up to 3 AI
// attempts now possible per request (see lib/ai/sow-content.ts). This is
// a defensive complement to the retry logic below, not a replacement for
// it: a real infra timeout was also worth ruling out explicitly.
// 60s was sized for a single generation attempt; worst case is now up to
// 3 sequential attempts (see retry loop below), so this needs more room.
export const maxDuration = 120

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { getPendingApprovalForDocument } from '@/lib/approvals/engine'
import { logAudit } from '@/lib/utils/audit'
import { sanitizeRichText } from '@/lib/utils/sanitize'
import { canReadProject } from '@/lib/utils/project-access'
import { checkAiRateLimit, recordAiUsage } from '@/lib/utils/rate-limit'
import Anthropic from '@anthropic-ai/sdk'
import {
  SOW_SECTION_DEFS, buildBoilerplateSections,
  buildSowContentPrompt, parseDelimitedSections, parseTableSections,
  buildFallbackSections, buildFallbackTables,
  SowContentParseError, type SowContentInput,
} from '@/lib/ai/sow-content'
import { TABLE_SECTION_IDS, type SowTableSectionId, type SowTableRow } from '@/lib/sow/table-schema'
import { roundCurrency } from '@/lib/utils/format'

// FIX (re-audit — build-blocking): was constructed at module scope, so an
// unset ANTHROPIC_API_KEY turns importing this route into a hard build
// failure instead of a runtime error. Lazy singleton, same fix as
// lib/email/templates.ts and lib/ai/guardian.ts.
let _client: Anthropic | null = null
function anthropicClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}
const MODEL  = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001'

const PAYMENT_STRUCTURE_LABELS: Record<string, string> = {
  '50_50':       '50% due upfront, 50% due upon final delivery',
  '100_upfront': '100% due before work commences',
  'milestones':  'Payable in milestones as defined below',
  'monthly':     'Billed monthly in advance',
  'on_delivery': '100% due upon final delivery and approval',
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'EDIT_SOW'))
      return NextResponse.json({ error: 'Missing permission: EDIT_SOW' }, { status: 403 })

    const {
      projectId, projectType, objective, deliverables,
      outOfScope, timeline, paymentStructure, revisionRounds,
      contractValue: rawContractValue, currency,
    } = await request.json()

    if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 })

    // FIX (bug — one-cent mismatch between PDF header and AI-drafted body
    // text): see lib/utils/format.ts's roundCurrency doc comment. Rounding
    // here means the AI is never shown a value with more than 2 decimal
    // digits, so it can't independently round a raw 3-decimal figure to a
    // different penny than the numeric display path does elsewhere in the
    // document.
    const contractValue = roundCurrency(Number(rawContractValue) || 0)

    const service = createServiceClient()

    // Fetch project + client + workspace for context
    const { data: project } = await (service as any)
      .from('projects')
      .select('id,name,disc,currency,clients(name,email,company_name),workspaces(agency_name,governing_law,sow_language)')
      .eq('id', projectId).eq('workspace_id', session.workspaceId).single()
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // FIX (audit round 3): no rate limiting existed on this route.
    const limited = await checkAiRateLimit(service, session.id, 'sow.generate')
    if (!limited.allowed) return NextResponse.json({ error: limited.message }, { status: 429 })

    const agencyName    = project.workspaces?.agency_name || session.agencyName
    const clientName    = project.clients?.company_name || project.clients?.name || 'Client'
    // FIX (doc-completeness audit, finding #1): this used to silently
    // fall back to a hardcoded country ('Republic of Kenya') whenever
    // workspaces.governing_law was unset — which, before the write-through
    // fix in app/api/workspace/defaults/route.ts, was every workspace,
    // regardless of what the agency thought they'd chosen during
    // onboarding. Governing law is a real, material legal term of the
    // contract; guessing it on the agency's behalf produced SOWs with a
    // silently wrong jurisdiction. Hard-block instead, same pattern
    // already used for invoice due date / payment instructions.
    const governingLaw  = project.workspaces?.governing_law?.trim() || null
    if (!governingLaw) {
      return NextResponse.json({
        error: 'Set your workspace\'s governing law in Settings → Workspace before generating a SOW.',
      }, { status: 400 })
    }
    const paymentLabel  = PAYMENT_STRUCTURE_LABELS[paymentStructure] || paymentStructure
    const curr          = currency || project.currency || 'USD'

    // ── AI content generation, with silent retries and a guaranteed
    // deterministic fallback ────────────────────────────────────────
    // FIX (production reliability — "AI returned invalid JSON. Please
    // try again."): see lib/ai/sow-content.ts for the full writeup. In
    // short: the model is never asked for JSON anymore (only plain
    // delimited content, which is far more forgiving to parse), a
    // couple of parse failures are retried silently server-side before
    // the user ever sees anything, and if the model still can't produce
    // a valid response, buildFallbackSections() guarantees a complete,
    // usable SOW anyway — this endpoint can no longer hard-fail the
    // user for reasons outside their control.
    const contentInput: SowContentInput = {
      agencyName, clientName, projectName: project.name, projectDisc: project.disc,
      projectType, contractValue, currency: curr, objective, deliverables,
      outOfScope, timeline, paymentLabel, revisionRounds: revisionRounds || 2, governingLaw,
    }

    const MAX_ATTEMPTS = 3
    let aiSections: Record<string, string> | null = null
    let aiTables: Record<SowTableSectionId, SowTableRow[]> | null = null
    let usedFallback = false
    let lastStopReason: string | null = null

    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !aiSections; attempt++) {
      const prompt = buildSowContentPrompt(contentInput, { emphatic: attempt > 1 })
      try {
        const msg = await anthropicClient().messages.create({
          model:      MODEL,
          max_tokens: 8000,
          messages:   [{ role: 'user', content: prompt }],
        })
        await recordAiUsage(service, session.workspaceId, session.id, 'sow.generate')
        const raw = msg.content.filter(b => b.type === 'text').map((b: any) => b.text).join('')
        lastStopReason = msg.stop_reason
        aiSections = parseDelimitedSections(raw)
        aiTables = parseTableSections(raw)
      } catch (err) {
        const reason = err instanceof SowContentParseError
          ? err.message
          : (err instanceof Error ? err.message : String(err))
        console.error(`SOW content generation attempt ${attempt}/${MAX_ATTEMPTS} failed:`, reason, 'stop_reason:', lastStopReason)
        // Loop continues to next attempt (or falls through to fallback below)
      }
    }

    if (!aiSections) {
      console.error('SOW content generation: all attempts failed, using deterministic fallback', { projectId })
      aiSections = buildFallbackSections(contentInput)
      usedFallback = true
    }

    // Tables are parsed leniently and never throw — a table can come back
    // empty (model skipped it, or every row was malformed) without taking
    // the whole generation down. Fall back per-table, not per-document.
    const fallbackTables = buildFallbackTables(contentInput)
    const tables: Record<SowTableSectionId, SowTableRow[]> = {
      deliverables: aiTables?.deliverables?.length ? aiTables.deliverables : fallbackTables.deliverables,
      timeline:     aiTables?.timeline?.length     ? aiTables.timeline     : fallbackTables.timeline,
      roles:        aiTables?.roles?.length        ? aiTables.roles        : fallbackTables.roles,
    }

    const boilerplate = buildBoilerplateSections(contentInput)
    const allContent: Record<string, string> = { ...boilerplate, ...aiSections }

    const parsed: { sections: any[]; metadata: any } = {
      sections: SOW_SECTION_DEFS.map(def => ({
        id: def.id,
        title: def.title,
        content: sanitizeRichText(allContent[def.id] || ''),
        ...(TABLE_SECTION_IDS.includes(def.id as SowTableSectionId) ? { table: tables[def.id as SowTableSectionId] } : {}),
        visible: true,
        order: def.order,
      })),
      // Metadata is entirely server-derived from the request — never
      // asked of the model, so it can never be malformed or missing.
      metadata: {
        paymentStructure: paymentStructure,
        revisionRounds: revisionRounds || 2,
        governingLaw: governingLaw,
        aiGenerated: !usedFallback,
      },
    }

    // Check for existing draft SOW on this project
    const { data: existingSow } = await (service as any)
      .from('sow_documents')
      .select('id,version')
      .eq('project_id', projectId)
      .eq('status', 'draft')
      .order('version', { ascending: false })
      .limit(1)
      .single()

    let sowId: string

    if (existingSow) {
      // FIX (re-audit, critical finding, same gate-bypass class as
      // api/sow/[id]/route.ts PATCH): this reuses the existing draft row
      // — including one currently gated by a pending approval request —
      // and overwrites its content wholesale via AI regeneration. Same
      // fix: refuse to touch a draft with an approval decision
      // outstanding.
      if (await getPendingApprovalForDocument(service, 'sow', existingSow.id)) {
        return NextResponse.json(
          { error: 'This SOW has a pending approval request — cancel it before regenerating.' },
          { status: 409 }
        )
      }
      // Update existing draft
      await (service as any).from('sow_documents')
        .update({ sections: parsed.sections, metadata: parsed.metadata, updated_at: new Date().toISOString() })
        .eq('id', existingSow.id)
      sowId = existingSow.id
    } else {
      // Get latest version number
      const { data: latestSow } = await (service as any)
        .from('sow_documents')
        .select('version')
        .eq('project_id', projectId)
        .order('version', { ascending: false })
        .limit(1)
        .single()
      const nextVersion = (latestSow?.version || 0) + 1

      const { data: newSow, error: sowErr } = await (service as any)
        .from('sow_documents')
        .insert({
          project_id:   projectId,
          workspace_id: session.workspaceId,
          version:      nextVersion,
          status:       'draft',
          sections:     parsed.sections,
          metadata:     parsed.metadata,
        })
        .select('id').single()
      if (sowErr) throw new Error(sowErr.message)
      sowId = newSow.id
    }

    // Update project status to Intake if still Draft
    await (service as any).from('projects')
      .update({ status: 'Intake', updated_at: new Date().toISOString() })
      .eq('id', projectId).eq('status', 'Draft')

    await logAudit(service, {
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'sow.drafted', entityType: 'sow',
      entityId: sowId, entityName: project.name,
      metadata: { project_type: projectType },
    })

    // Note: AI usage is recorded per actual model call inside the retry
    // loop above (accurate cost/rate-limit accounting), not again here.
    return NextResponse.json({ sowId })
  } catch (err) {
    console.error('SOW generate error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal error' }, { status: 500 })
  }
}

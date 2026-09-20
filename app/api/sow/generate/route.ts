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
import { applyAgencyStandards, ensureContractValueStated, type AgencyStandards } from '@/lib/ai/sow-content'
import { canReadProject } from '@/lib/utils/project-access'
import { checkAiRateLimit, recordAiUsage } from '@/lib/utils/rate-limit'
import Anthropic from '@anthropic-ai/sdk'
import {
  SOW_SECTION_DEFS, buildBoilerplateSections,
  buildSowContentPrompt, parseDelimitedSections, parseTableSections,
  buildFallbackSections, buildFallbackTables,
  SowContentParseError, sectionTitle, type SowContentInput,
} from '@/lib/ai/sow-content'
import { TABLE_SECTION_IDS, type SowTableSectionId, type SowTableRow } from '@/lib/sow/table-schema'
import { roundCurrency } from '@/lib/utils/format'
import { insertNextSowVersion } from '@/lib/documents/sow-version'

// FIX (section-9 audit, 9-B11): none of the free-text brief fields were
// length-capped before going into the prompt. api/sow/parse-brief caps
// its input at 8000 chars; this route — which takes the same text after
// the user has edited it — capped nothing at all, so a single request
// could push an arbitrary amount of text through the model (cost/latency)
// and crowd out the actual drafting instructions. Generous enough that no
// real brief is ever truncated.
const FIELD_LIMITS = { objective: 4000, deliverables: 8000, outOfScope: 4000, timeline: 2000, projectType: 120 }

function capped(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
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

    const body = await request.json()
    const { projectId } = body

    if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 })

    // FIX (section-9 audit, 9-B11): every one of these went into the AI
    // prompt — and, for paymentStructure, straight into the drafted
    // contract text — completely unvalidated.
    const projectType   = capped(body.projectType,   FIELD_LIMITS.projectType)
    const objective     = capped(body.objective,     FIELD_LIMITS.objective)
    const deliverables  = capped(body.deliverables,  FIELD_LIMITS.deliverables)
    const outOfScope    = capped(body.outOfScope,    FIELD_LIMITS.outOfScope)
    const timeline      = capped(body.timeline,      FIELD_LIMITS.timeline)

    // `PAYMENT_STRUCTURE_LABELS[x] || x` used to echo any arbitrary
    // client-supplied string into the Payment Terms section of a legal
    // document as though it were a real payment structure. It's a closed
    // set — treat it as one.
    const paymentStructure = String(body.paymentStructure || '')
    if (!Object.prototype.hasOwnProperty.call(PAYMENT_STRUCTURE_LABELS, paymentStructure))
      return NextResponse.json({ error: 'Invalid payment structure' }, { status: 400 })

    // The prompt has always told the model "an integer between 1 and 5";
    // nothing enforced it, so `revisionRounds || 2` happily carried a
    // negative, a float, or 1e9 into both the prompt and the stored
    // metadata that the Revision Policy section is written against.
    const parsedRounds   = Math.trunc(Number(body.revisionRounds))
    const revisionRounds = Number.isFinite(parsedRounds) && parsedRounds >= 1 && parsedRounds <= 10
      ? parsedRounds
      : 2

    const service = createServiceClient()

    // Fetch project + client + workspace for context
    const { data: project } = await (service as any)
      .from('projects')
      .select('id,name,disc,type,contract_value,currency,clients(name,email,company_name),workspaces(agency_name,governing_law,sow_language)')
      .eq('id', projectId).eq('workspace_id', session.workspaceId).is('deleted_at', null).single()
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // One live SOW per project. A SOW that is out for signature, or already signed, is the
    // agreement — generating another version next to it left two signable documents for one
    // project (double milestones on signing, a project flipped back to "Awaiting Signature"
    // while active, an executed SOW hidden behind a newer draft in the UI). Changes to a
    // signed scope go through a change order; changes to one awaiting signature go through
    // Withdraw first. Checked BEFORE the rate limit and the model call so a refused request
    // costs nothing.
    const { data: liveSows } = await (service as any)
      .from('sow_documents').select('id, status, version')
      .eq('project_id', projectId).in('status', ['awaiting_signature', 'signed']).limit(1)
    if (liveSows && liveSows.length > 0) {
      return NextResponse.json({
        error: liveSows[0].status === 'signed'
          ? 'This project already has a signed SOW. Use a change order to change the agreed scope.'
          : 'A SOW for this project is out for signature. Withdraw it before generating a new one.',
      }, { status: 409 })
    }

    // FIX (audit round 3): no rate limiting existed on this route.
    const limited = await checkAiRateLimit(service, session.id, 'sow.generate')
    if (!limited.allowed) return NextResponse.json({ error: limited.message }, { status: 429 })

    const agencyName    = project.workspaces?.agency_name || session.agencyName
    const clientName    = project.clients?.company_name || project.clients?.name || 'Client'
    // FIX (SOW-lifecycle fix round — headline finding): contractValue and
    // currency used to come straight from the request body — every other
    // legally-material field in this route is validated against a closed
    // set or hard-blocked (paymentStructure, revisionRounds, governingLaw),
    // but these two, arguably the most consequential for a monetary
    // contract, were trusted from the client with no cross-check against
    // this project's own record, and this route didn't even select
    // contract_value to check against. The AI-drafted Payment Terms prose
    // (and the deterministic fallback) is built from whatever value was
    // posted, while the PDF header, the portal display, the send-time
    // footing check, and the approval-gate amount all separately read
    // projects.contract_value/currency — so a stale or mismatched request
    // body could produce a signed contract stating two different totals on
    // the same document. Read both authoritatively off the project record
    // instead of trusting the request.
    const contractValue = roundCurrency(project.contract_value || 0)
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
    const paymentLabel  = PAYMENT_STRUCTURE_LABELS[paymentStructure]
    const curr          = project.currency || 'USD'

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
    // The agency's saved standard terms for this kind of project (falls back to their
    // workspace-wide row). Best effort: a failed lookup just means no standards are applied.
    let standards: AgencyStandards | null = null
    try {
      const { data: defaultRows } = await (service as any)
        .from('workspace_defaults')
        .select('project_type, revision_policy, payment_terms, out_of_scope_clauses, assumptions')
        .eq('workspace_id', session.workspaceId)
      const rows: any[] = Array.isArray(defaultRows) ? defaultRows : []
      const row = rows.find(r => r.project_type === project.type) || rows.find(r => !r.project_type)
      if (row) standards = {
        revisionPolicy: row.revision_policy, paymentTerms: row.payment_terms,
        outOfScopeClauses: row.out_of_scope_clauses, assumptions: row.assumptions,
      }
    } catch (e) { console.error('SOW generate: workspace_defaults lookup failed', e) }

    const contentInput: SowContentInput = {
      agencyName, clientName, projectName: project.name, projectDisc: project.disc,
      projectType, contractValue, currency: curr, objective, deliverables,
      outOfScope, timeline, paymentLabel, paymentStructure, revisionRounds, governingLaw,
      // FIX (deep audit, section 5 re-pass): sow_language was already
      // being selected right above (line 76) and then dropped on the
      // floor — the workspace's language preference never actually
      // reached generation. See lib/ai/sow-content.ts for the prompt
      // instruction and translated boilerplate this now drives.
      language: project.workspaces?.sow_language || 'en',
      standards,
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
    // FEATURE (section-9 audit follow-up): the AI is instructed to leave
    // Amount at 0 on every payment_schedule row (see buildSowContentPrompt)
    // — money math is never trusted to the model anywhere else in this
    // file (see the "Metadata is entirely server-derived" comment below),
    // and payment amounts are exactly the kind of number that needs to
    // foot exactly, not approximately. This computes an equal split
    // across whatever rows the AI proposed, rounded so it sums EXACTLY to
    // the contract value — the last row absorbs any rounding remainder,
    // same technique used everywhere else a total gets split (the 50/50
    // structure below, buildFallbackTables' own 30/40/30 split, and the
    // CO counter-negotiation rescale).
    // FIX (section-9 audit, build-blocking): declared as a hoisted
    // `function` inside a block, which ES5-targeted strict mode rejects
    // (TS1252) — this failed `tsc --noEmit`. Function expression instead.
    const withComputedAmounts = (rows: SowTableRow[]): SowTableRow[] => {
      if (rows.length === 0) return rows
      const base = roundCurrency(contractValue / rows.length)
      const amounts = rows.map(() => base)
      const drift = roundCurrency(contractValue - amounts.reduce((s, a) => s + a, 0))
      amounts[amounts.length - 1] = roundCurrency(amounts[amounts.length - 1] + drift)
      return rows.map((r, i) => ({ ...r, amount: String(amounts[i]) }))
    }
    const tables: Record<SowTableSectionId, SowTableRow[]> = {
      deliverables: aiTables?.deliverables?.length ? aiTables.deliverables : fallbackTables.deliverables,
      timeline:     aiTables?.timeline?.length     ? aiTables.timeline     : fallbackTables.timeline,
      roles:        aiTables?.roles?.length        ? aiTables.roles        : fallbackTables.roles,
      payment_schedule: paymentStructure !== 'milestones' ? [] :
        aiTables?.payment_schedule?.length ? withComputedAmounts(aiTables.payment_schedule) : fallbackTables.payment_schedule,
    }

    const boilerplate = buildBoilerplateSections(contentInput)
    const allContent: Record<string, string> = applyAgencyStandards({ ...boilerplate, ...aiSections }, standards)
    // The contract value is data, the payment prose is model-written: never let them disagree.
    allContent.payment = ensureContractValueStated(allContent.payment || '', contractValue, curr)

    const parsed: { sections: any[]; metadata: any } = {
      sections: SOW_SECTION_DEFS.map(def => ({
        id: def.id,
        // FIX (section-9 audit, 9-G7): section headings are part of the
        // document the client reads, so they follow the workspace's SOW
        // language like the body content does.
        title: sectionTitle(def.id, contentInput.language),
        content: sanitizeRichText(allContent[def.id] || ''),
        ...(TABLE_SECTION_IDS.includes(def.id as SowTableSectionId) ? { table: tables[def.id as SowTableSectionId] } : {}),
        // FEATURE (section-9 audit follow-up): every other section
        // defaults to visible — payment_schedule is the one exception,
        // shown by default only when it's actually relevant (the agency
        // chose 'milestones'). Still toggleable by hand either way, same
        // as any other non-required section.
        visible: def.id === 'payment_schedule' ? paymentStructure === 'milestones' : true,
        order: def.order,
      })),
      // Metadata is entirely server-derived from the request — never
      // asked of the model, so it can never be malformed or missing.
      metadata: {
        paymentStructure: paymentStructure,
        revisionRounds,
        governingLaw: governingLaw,
        // FIX (section-9 audit, 9-G7): persist the language the document
        // was drafted in. Without it, every later read path (the PATCH
        // section-schema normalizer, the PDF renderer, the portal page)
        // had no way to know and silently reverted headings to English.
        language: contentInput.language,
        aiGenerated: !usedFallback,
      },
    }

    // Check for existing draft SOW on this project
    const { data: existingSow } = await (service as any)
      .from('sow_documents')
      .select('id,version,metadata')
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
      // FIX (section-9 audit, 9-G4 — feature gap follow-on): parsed.metadata
      // is entirely server-derived from THIS request's brief inputs and
      // knows nothing about fields the agency may have set by hand on the
      // existing draft since it was last generated — msaReference (see
      // components/sow/SowEditor.tsx) and metadata.changeRequest (9-G8)
      // are both like this. Overwriting metadata wholesale silently
      // discarded them on every regenerate. Carry them forward.
      const { data: overwritten, error: overwriteErr } = await (service as any).from('sow_documents')
        .update({
          sections: parsed.sections,
          metadata: {
            ...parsed.metadata,
            ...(existingSow.metadata?.msaReference ? { msaReference: existingSow.metadata.msaReference } : {}),
            ...(existingSow.metadata?.changeRequest ? { changeRequest: existingSow.metadata.changeRequest } : {}),
          },
          updated_at: new Date().toISOString(),
        })
        // Guarded on the write itself: if the draft was sent while the model was thinking
        // (this route can take 20+ seconds), overwriting it would replace the content of a
        // document already in front of the client.
        .eq('id', existingSow.id).eq('status', 'draft').is('sent_at', null)
        .select('id')
      if (overwriteErr) throw new Error(overwriteErr.message)
      if (!overwritten || overwritten.length === 0)
        return NextResponse.json({ error: 'This SOW was sent while it was being regenerated, so nothing was changed.' }, { status: 409 })
      sowId = existingSow.id
    } else {
      // FIX (section-9 audit, 9-B12): the old read-max-then-insert had no
      // uniqueness backstop, so two concurrent generates both allocated
      // the same version. Migration 031 adds UNIQUE(project_id, version)
      // and this helper retries against it. See lib/documents/sow-version.ts.
      const created = await insertNextSowVersion(service, projectId, {
        workspace_id: session.workspaceId,
        status:       'draft',
        sections:     parsed.sections,
        metadata:     parsed.metadata,
      })
      if (!created.ok) {
        // The one-draft-per-project index (migration 061) rejects a concurrent second draft.
        if (/one_draft_per_project|duplicate key/i.test(created.error || ''))
          return NextResponse.json({ error: 'A draft SOW was just created for this project. Refresh and open it.' }, { status: 409 })
        throw new Error(created.error || 'Could not create SOW')
      }
      sowId = created.id!
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
    return NextResponse.json({ error: 'Could not generate the SOW. Please try again.' }, { status: 500 })
  }
}

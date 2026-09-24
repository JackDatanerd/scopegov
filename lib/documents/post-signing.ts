// lib/documents/post-signing.ts
//
// The steps that run AFTER a client signs a SOW, extracted from app/api/portal/sow/[token]/sign/route.ts so the
// sign route and the repair sweep (lib/documents/signing-integrity.ts) share ONE implementation of each:
//   • extractDeliverables / buildScopeSnapshotContent — the Guardian baseline taken from the signed sections,
//   • writeScopeSnapshot                              — the project_scope_snapshot upsert (with its version bump),
//   • ensureGuardianEmail                             — the project's stable inbound address,
//   • createSowMilestones                             — the payment milestones for the agreed structure.
//
// Signing is a chain of independent writes (there is no cross-table transaction available through PostgREST),
// and each of these can fail on its own after the signature has already been recorded. They report their
// outcome so the caller can log it AND so the repair sweep can tell what is missing and redo just that.

import { logAudit } from '@/lib/utils/audit'
import { parseTableAmount } from '@/lib/sow/table-schema'
import { roundCurrency } from '@/lib/utils/format'
import { decodeHtmlEntities } from '@/lib/utils/sanitize'

/** Deliverables + out-of-scope items the Guardian classifier treats as the agreed baseline. */
export function buildScopeSnapshotContent(sections: any[]): {
  deliverables: Array<{ title: string }>; outOfScope: Array<{ title: string }>
} {
  // The 'deliverables' section moved from prose `content` to a structured `table` (lib/sow/table-schema.ts);
  // read the table first and fall back to HTML extraction only for pre-refactor SOWs.
  const deliverablesSection = (sections || []).find((s: any) => s.id === 'deliverables')
  const deliverables = (deliverablesSection?.table || []).length > 0
    ? (deliverablesSection.table as Array<Record<string, string>>)
        .map(row => ({ title: (row.deliverable || '').trim() }))
        .filter(d => d.title)
    : extractDeliverables(deliverablesSection?.content || '')
  const outOfScope = extractDeliverables((sections || []).find((s: any) => s.id === 'oos')?.content || '')
  return { deliverables, outOfScope }
}

/**
 * Writes the project's Guardian baseline. supabase-js returns errors instead of throwing — an unchecked failure
 * used to leave a signed SOW with no baseline and no record that anything had gone wrong; the result is returned.
 * The update path advances `version` (migration 045: it is what lets app/api/guardian/scope-adjustment's
 * compare-and-swap detect a re-sign landing between its read and its write).
 */
export async function writeScopeSnapshot(
  service: any, projectId: string, sections: any[], nowIso: string,
): Promise<{ error?: string }> {
  const { deliverables, outOfScope } = buildScopeSnapshotContent(sections)
  const { data: existingSnap } = await service
    .from('project_scope_snapshot').select('id,version').eq('project_id', projectId).maybeSingle()
  const res = existingSnap
    ? await service.from('project_scope_snapshot').update({
        deliverables, out_of_scope: outOfScope,
        last_updated_at: nowIso, last_updated_by: 'signing',
        version: (existingSnap.version || 1) + 1,
      }).eq('project_id', projectId)
    : await service.from('project_scope_snapshot').insert({
        project_id: projectId, deliverables, out_of_scope: outOfScope,
        last_updated_at: nowIso, last_updated_by: 'signing',
      })
  return res.error ? { error: res.error.message || String(res.error) } : {}
}

/**
 * The project's stable inbound Guardian address. Stable for the life of the project: only generated when the
 * project has none, derived from the project id, and checked for collisions (the inbound handler resolves a
 * project with .single() on this value). Returns '' when none could be produced (all candidates clashed).
 */
export async function ensureGuardianEmail(
  service: any, project: { id: string; guardian_email?: string | null },
): Promise<{ email: string; created: boolean; error?: string }> {
  if (project.guardian_email) return { email: project.guardian_email, created: false }
  const guardianDomain = process.env.NEXT_PUBLIC_GUARDIAN_EMAIL_DOMAIN || 'guard.scopegov.app'
  const compact = String(project.id).replace(/-/g, '')
  let guardianEmail = ''
  for (const len of [8, 12, 16, 20, 32]) {
    const candidate = `proj-${compact.slice(0, len)}@${guardianDomain}`
    const { data: clash } = await service
      .from('projects').select('id').ilike('guardian_email', candidate).neq('id', project.id).limit(1)
    if (!clash || clash.length === 0) { guardianEmail = candidate; break }
  }
  if (!guardianEmail) return { email: '', created: false, error: 'every candidate address was already taken' }
  const { error } = await service.from('projects').update({ guardian_email: guardianEmail }).eq('id', project.id)
  if (error) return { email: '', created: false, error: error.message }
  return { email: guardianEmail, created: true }
}

// Pulls plain-text items out of a rich-text section: <li> items, falling back to paragraphs.
// `[\s\S]*?` (not `.`) so an item that spans lines is not silently dropped, entities are decoded
// (Guardian classifies client messages against this text, so "R&amp;D" must read "R&D"), and the
// cap is generous — an out-of-scope list past 50 items used to be cut off without a word.
export function extractDeliverables(html: string): Array<{ title: string }> {
  if (!html) return []
  const clean = (fragment: string) =>
    decodeHtmlEntities(fragment.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
  const items: Array<{ title: string }> = []
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi
  let match
  while ((match = liRegex.exec(html)) !== null) {
    const text = clean(match[1])
    if (text) items.push({ title: text })
  }
  if (!items.length) {
    const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi
    while ((match = pRegex.exec(html)) !== null) {
      const text = clean(match[1])
      if (text && text.length > 3) items.push({ title: text })
    }
  }
  return items.slice(0, 200)
}

// FIX (re-audit): this used to (a) insert milestones one at a time in a
// loop, so a failure partway through a multi-milestone structure (e.g. the
// 50/50 split) could leave only the first milestone on file with no
// indication anything was wrong, and (b) swallow any failure into
// console.error only — the SOW still ends up 'signed' with NO payment
// milestones at all, silently blocking invoicing for the project with
// nothing operator-visible. Insert as a single batch (one INSERT statement
// is atomic — either all rows land or none do, no partial split) and log
// an audit entry on failure so it's at least discoverable, rather than a
// server log line nobody will see.
//
// FIX (cron/portal audit round 3): moved out of the sign route into this shared module (and made to REPORT its
// outcome) so lib/documents/signing-integrity.ts — the repair sweep behind api/cron/signing-integrity — can
// re-run it for a signed SOW whose milestones never landed. `signedAt` lets that repair stamp a monthly
// retainer's first milestone with the day the client actually signed, not the day the repair ran.
export async function createSowMilestones(
  service: any, projectId: string, sowId: string, workspaceId: string,
  metadata: any, contractValue: number, currency: string, sections: any[],
  signedAt?: Date,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const structure = metadata?.paymentStructure || '50_50'
    const milestones = []

    if (structure === '50_50') {
      // FIX (bug — payment split not summing to contract value): rounding
      // each half independently (roundCurrency(cv * 0.5) applied to both)
      // can produce two halves that don't sum back to the contract value
      // when the total has an odd cent — e.g. $1599.97 * 0.5 = $799.985,
      // which rounds to $799.99 on both sides, summing to $1599.98, a
      // cent more than the contract. Round the first share, then set the
      // second to whatever's left — guarantees an exact sum every time,
      // with any leftover cent absorbed by the final milestone. Standard
      // practice for splitting a currency total across N shares.
      const upfront = roundCurrency(contractValue * 0.5)
      const final   = roundCurrency(contractValue - upfront)
      milestones.push(
        { title: 'Upfront payment (50%)',   amount: upfront, trigger: 'Project kick-off',       type: 'percentage', percentage: 50 },
        { title: 'Final payment (50%)',      amount: final,   trigger: 'Final delivery approval', type: 'percentage', percentage: 50 },
      )
    } else if (structure === '100_upfront') {
      milestones.push({ title: 'Full payment', amount: roundCurrency(contractValue), trigger: 'Before work commences', type: 'fixed', percentage: null })
    } else if (structure === 'on_delivery') {
      milestones.push({ title: 'Full payment', amount: roundCurrency(contractValue), trigger: 'Final delivery approval', type: 'fixed', percentage: null })
    } else if (structure === 'monthly') {
      // FIX (section-9 re-pass): this created the milestone with no
      // due_date. app/api/cron/retainer-milestones de-dupes each month's
      // row strictly by matching due_date to the 1st of the target
      // month, so a NULL due_date here could never match — the cron's
      // first run after signing couldn't tell this row apart from "no
      // milestone yet for this month" and inserted a second full-amount
      // "Monthly retainer" row for the same month. Setting due_date to
      // the 1st of the signing month gives the cron the same key it
      // computes for itself, closing that gap.
      // FIX (cron/portal audit round 2): this stamped the FIRST of the signing month. Signed on the 20th, that is a
      // due date 19 days in the past — payment-overdue then flagged the brand-new milestone "overdue" (and
      // notified/emailed finance) the next morning, for a contract signed a day earlier. Stamp the signing DAY
      // instead. The retainer cron no longer keys on the exact date: it counts a month as present when ANY
      // retainer_monthly row's due_date falls inside it (and migration 063's unique index is per month), so
      // this row still suppresses a second one for the same month.
      const signedOn = signedAt ?? new Date()
      const signingDay = `${signedOn.getUTCFullYear()}-${String(signedOn.getUTCMonth() + 1).padStart(2, '0')}-${String(signedOn.getUTCDate()).padStart(2, '0')}`
      milestones.push({ title: 'Monthly retainer', amount: roundCurrency(contractValue), trigger: 'Monthly — first of month', type: 'retainer_monthly', percentage: null, dueDate: signingDay })
    } else if (structure === 'milestones') {
      // FIX (section-9 audit, real bug — now genuinely fixed): 'milestones'
      // is a selectable payment structure (the SOW boilerplate literally
      // prints "Payable in milestones as defined below") but there was
      // never any table/UI for an agency to actually define what those
      // milestones are — deliverables/timeline/roles all had dedicated
      // table sections, payment schedule never did. This branch used to
      // fall into the generic `else` below and silently create ONE
      // "Project payment" milestone for the FULL contract value,
      // contradicting the SOW's own printed text.
      //
      // FEATURE (built): lib/sow/table-schema.ts now defines a real
      // payment_schedule table section, same architecture as deliverables/
      // timeline/roles — the agency itemizes it in SowEditor, AI
      // generation proposes a starting split (with amounts always
      // server-computed, never AI money-math — see
      // app/api/sow/generate/route.ts), and this reads those rows
      // directly instead of guessing. The send route (see send/route.ts)
      // now validates this foots to the contract value BEFORE the SOW
      // ever reaches the client, so this sign-time check is a backstop,
      // not the primary safety net — it should only ever trip if that
      // send-time validation was somehow bypassed.
      const scheduleSection = (sections || []).find((s: any) => s.id === 'payment_schedule')
      const rows: any[] = Array.isArray(scheduleSection?.table) ? scheduleSection.table : []
      const parsedRows = rows
        .map((r: any) => ({
          title: String(r?.milestone || '').trim(),
          // FIX (section-9 audit, 9-G6): bare Number() on a free-text
          // cell makes "1,500" NaN, which dropped the row and silently
          // collapsed the whole negotiated schedule to a single lump-sum
          // milestone. Same parser the send-time validation uses.
          amount: parseTableAmount(r?.amount) ?? 0,
          trigger: String(r?.trigger || '').trim(),
        }))
        .filter(r => r.title && r.amount > 0)
      const scheduleSum = parsedRows.reduce((s, r) => s + r.amount, 0)

      if (parsedRows.length > 0 && Math.abs(scheduleSum - contractValue) < 0.01) {
        for (const r of parsedRows) {
          milestones.push({
            title:   r.title.slice(0, 200),
            amount:  roundCurrency(r.amount),
            trigger: (r.trigger || 'As defined in the SOW').slice(0, 500),
            type: 'fixed', percentage: null,
          })
        }
      } else {
        // Genuinely defensive at this point (send-time validation should
        // have already blocked this) — an honest fallback rather than a
        // silent one, and flagged in the audit log so it's discoverable
        // if it ever does happen (e.g. a future edit path that bypasses
        // the send-time check).
        //
        // FIX (build, Reports & Audit re-pass): this and the two other
        // logAudit calls in this function were `actorId: ''` — an empty
        // string is just as invalid a uuid as the literal 'system' string
        // this codebase already fixed everywhere else (see
        // lib/utils/audit.ts). The insert failed silently (supabase-js
        // doesn't throw on a DB error, and it was never checked here), so
        // these two "make sure this is discoverable if it ever happens"
        // events were, in fact, never discoverable. null is the correct
        // value.
        milestones.push({
          title: 'Project payment', amount: roundCurrency(contractValue),
          trigger: 'Full contract value — no itemized milestone schedule was defined in this SOW',
          type: 'fixed', percentage: null,
        })
        await logAudit(service, {
          workspaceId, actorId: null, actorEmail: 'system@scopegov.app', actorName: 'ScopeGov',
          eventType: 'sow.milestone_schedule_undefined', entityType: 'sow', entityId: sowId,
          metadata: { project_id: projectId, contract_value: contractValue, rows_found: rows.length, rows_valid: parsedRows.length, schedule_sum: scheduleSum },
        }).catch(() => {})
      }
    } else {
      milestones.push({ title: 'Project payment', amount: roundCurrency(contractValue), trigger: 'As per agreement', type: 'fixed', percentage: null })
    }

    const { error: insertErr } = await (service as any).from('payment_milestones').insert(
      milestones.map(m => ({
        project_id:   projectId,
        sow_id:       sowId,
        title:        m.title,
        type:         m.type,
        amount:       m.amount,
        percentage:   m.percentage,
        trigger:      m.trigger,
        due_date:     (m as any).dueDate ?? null,
        tax_rate:     0,
        tax_inclusive: false,
        status:       'pending',
      }))
    )

    if (insertErr) {
      console.error('Milestone creation failed:', insertErr)
      await logAudit(service, {
        workspaceId, actorId: null, actorEmail: 'system@scopegov.app', actorName: 'ScopeGov',
        eventType: 'sow.milestones_creation_failed', entityType: 'sow', entityId: sowId,
        metadata: { project_id: projectId, error: insertErr.message || String(insertErr) },
      }).catch(() => {})
      return { ok: false, error: insertErr.message || String(insertErr) }
    }
    return { ok: true }
  } catch (e) {
    console.error('Milestone creation failed:', e)
    await logAudit(service, {
      workspaceId, actorId: null, actorEmail: 'system@scopegov.app', actorName: 'ScopeGov',
      eventType: 'sow.milestones_creation_failed', entityType: 'sow', entityId: sowId,
      metadata: { project_id: projectId, error: e instanceof Error ? e.message : String(e) },
    }).catch(() => {})
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

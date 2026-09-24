// lib/documents/signing-integrity.ts
//
// FEATURE (cron/portal audit round 3): repair sweep for documents whose post-signature steps partly failed.
//
// Signing a SOW (app/api/portal/sow/[token]/sign) and accepting a change order (lib/documents/finalize-co.ts)
// are chains of independent writes — activate the project, create the payment milestones, write the Guardian
// baseline, mint the Guardian address, record the amendment — with no cross-table transaction available through
// PostgREST. The signature itself is the commit point; each later step can fail on its own, and until now the
// only trace was a console line and (for some) an audit event nobody reads. The consequences are quiet and
// expensive: a signed SOW whose project never became Active (the retainer cron bills only Active projects), a
// signed SOW with NO payment milestones (nothing to invoice), a project with no Guardian baseline (the scope-creep
// classifier has nothing to compare against), an accepted CO with no amendment (the effective contract value in
// every report is short by the CO's total).
//
// This finds those states among recently executed documents and redoes exactly the missing step, using the SAME
// helpers the live flow uses (lib/documents/post-signing.ts). It only looks at documents executed between
// `settleMinutes` and `windowDays` ago: not younger (the live flow may still be mid-way through its own steps),
// not older (a state that has survived two weeks is a decision, not a failure).
//
// Deliberately NOT repaired, only reported: content_hash and the frozen PDF. Both are fingerprints of the exact
// moment of signing (signature image, timestamp, live agency details); recomputing them later would manufacture
// a record that looks authoritative but isn't. The report names the documents so a human can decide.

import {
  createSowMilestones, ensureGuardianEmail, writeScopeSnapshot,
} from '@/lib/documents/post-signing'
import { isAdjustmentLine } from '@/lib/utils/rescale-line-items'
import { insertAuditRow } from '@/lib/utils/audit'
import { fetchAll } from '@/lib/utils/fetch-all'

export interface IntegrityOptions {
  now?: Date
  /** Ignore documents executed more recently than this (the live flow may still be running). */
  settleMinutes?: number
  /** Ignore documents executed longer ago than this. */
  windowDays?: number
}

export interface IntegrityReport {
  sowsChecked: number
  cosChecked: number
  repairs: Array<{ kind: 'sow' | 'co'; id: string; repair: string }>
  /** Problems that cannot be safely repaired automatically — surfaced to ops. */
  unrepairable: string[]
  /** Repairs that were attempted and failed (they will be retried on the next run). */
  failures: string[]
}

const SYSTEM = { actor_id: null, actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov' } as const

export async function runSigningIntegrity(service: any, opts: IntegrityOptions = {}): Promise<IntegrityReport> {
  const now = opts.now ?? new Date()
  const settleMs = (opts.settleMinutes ?? 30) * 60_000
  const windowMs = (opts.windowDays ?? 14) * 86_400_000
  const newest = new Date(now.getTime() - settleMs).toISOString()
  const oldest = new Date(now.getTime() - windowMs).toISOString()
  const report: IntegrityReport = { sowsChecked: 0, cosChecked: 0, repairs: [], unrepairable: [], failures: [] }

  const record = async (kind: 'sow' | 'co', workspaceId: string, id: string, name: string | null, repair: string, extra: Record<string, unknown> = {}) => {
    report.repairs.push({ kind, id, repair })
    await insertAuditRow(service, {
      workspace_id: workspaceId, ...SYSTEM,
      event_type: `${kind}.integrity_repaired`, entity_type: kind === 'sow' ? 'sow' : 'change_order',
      entity_id: id, entity_name: name,
      metadata: { repair, ...extra },
    })
  }

  // ── Signed SOWs ────────────────────────────────────────────────────────
  const sows = await fetchAll<any>('signing-integrity signed SOWs', (from, to) =>
    service.from('sow_documents')
      .select('id, version, workspace_id, project_id, signed_at, sections, metadata, content_hash, pdf_path, document_number, projects!inner(id, name, status, stall_reason, contract_value, currency, guardian_email, deleted_at)')
      .eq('status', 'signed')
      .gte('signed_at', oldest)
      .lte('signed_at', newest)
      .order('id')
      .range(from, to))

  for (const sow of sows) {
    const project = sow.projects
    if (!project || project.deleted_at) continue
    report.sowsChecked++
    const label = `SOW ${sow.document_number || sow.id}`
    const nowIso = now.toISOString()

    try {
      // 1. Project left behind at the pre-signature status.
      const stuckAwaiting = project.status === 'Awaiting Signature'
      const stuckStalled = project.status === 'Stalled' && project.stall_reason === 'sow_unsigned'
      if (stuckAwaiting || stuckStalled) {
        const { data: fixed, error } = await service.from('projects')
          .update({ status: 'Active', stall_reason: null, updated_at: nowIso })
          .eq('id', project.id).eq('status', project.status).select('id')
        if (error) throw new Error(`activate project: ${error.message}`)
        if (fixed?.length) await record('sow', sow.workspace_id, sow.id, project.name, 'project_activated', { from_status: project.status })
      }

      // 2. No payment milestones at all.
      const { count: milestoneCount, error: mcErr } = await service.from('payment_milestones')
        .select('id', { count: 'exact', head: true }).eq('sow_id', sow.id)
      if (mcErr) throw new Error(`count milestones: ${mcErr.message}`)
      if ((milestoneCount ?? 0) === 0) {
        const res = await createSowMilestones(
          service, project.id, sow.id, sow.workspace_id, sow.metadata,
          Number(project.contract_value) || 0, project.currency || 'USD', sow.sections || [],
          sow.signed_at ? new Date(sow.signed_at) : undefined,
        )
        if (!res.ok) throw new Error(`create milestones: ${res.error}`)
        await record('sow', sow.workspace_id, sow.id, project.name, 'milestones_created')
      }

      // 3. No Guardian baseline.
      const { data: snap, error: snapErr } = await service.from('project_scope_snapshot')
        .select('id').eq('project_id', project.id).maybeSingle()
      if (snapErr) throw new Error(`read scope snapshot: ${snapErr.message}`)
      if (!snap) {
        const w = await writeScopeSnapshot(service, project.id, sow.sections || [], nowIso)
        if (w.error) throw new Error(`write scope snapshot: ${w.error}`)
        await record('sow', sow.workspace_id, sow.id, project.name, 'scope_snapshot_written')
      }

      // 4. No Guardian inbound address.
      if (!project.guardian_email) {
        const g = await ensureGuardianEmail(service, project)
        if (g.error) throw new Error(`guardian email: ${g.error}`)
        if (g.created) await record('sow', sow.workspace_id, sow.id, project.name, 'guardian_email_created')
      }

      // 5. Fingerprints that can't be re-made honestly — report only.
      if (!sow.content_hash) report.unrepairable.push(`${label}: signed without a content_hash`)
      if (!sow.pdf_path) report.unrepairable.push(`${label}: signed without a frozen executed PDF`)
    } catch (e: any) {
      report.failures.push(`${label}: ${e?.message || String(e)}`)
    }
  }

  // ── Accepted change orders ─────────────────────────────────────────────
  const cos = await fetchAll<any>('signing-integrity accepted COs', (from, to) =>
    service.from('change_orders')
      .select('id, title, workspace_id, project_id, total, line_items, is_retainer_renewal, accepted_at, content_hash, pdf_path, projects!inner(id, name, type, deleted_at)')
      .eq('status', 'accepted')
      .gte('accepted_at', oldest)
      .lte('accepted_at', newest)
      .order('id')
      .range(from, to))

  for (const co of cos) {
    const project = co.projects
    if (!project || project.deleted_at) continue
    report.cosChecked++
    const label = `CO "${co.title}" (${co.id})`

    try {
      const { count: amendCount, error: acErr } = await service.from('amendments')
        .select('id', { count: 'exact', head: true }).eq('change_order_id', co.id)
      if (acErr) throw new Error(`count amendments: ${acErr.message}`)
      if ((amendCount ?? 0) === 0) {
        const isRenewal = !!co.is_retainer_renewal && project.type === 'retainer'
        if (isRenewal) {
          // A renewal's amendment records the rate it REPLACED (previous_contract_value) and the live rate has
          // since been overwritten — that number can't be reconstructed. Human call.
          report.unrepairable.push(`${label}: retainer renewal accepted with no amendment record (the replaced rate can't be reconstructed)`)
        } else {
          const { data: signedSow } = await service.from('sow_documents')
            .select('id').eq('project_id', co.project_id).eq('status', 'signed')
            .order('version', { ascending: false }).limit(1).maybeSingle()
          if (!signedSow) throw new Error('no signed SOW to attach the amendment to')
          const lineItems = typeof co.line_items === 'string' ? JSON.parse(co.line_items) : (co.line_items || [])
          const deliverables: string[] = lineItems.filter((l: any) => !isAdjustmentLine(l)).map((l: any) => l.description).filter(Boolean)
          const { error: insErr } = await service.from('amendments').insert({
            project_id: co.project_id, workspace_id: co.workspace_id, change_order_id: co.id,
            signed_sow_id: signedSow.id, title: `Amendment — ${co.title}`,
            added_deliverables: deliverables, removed_deliverables: [],
            financial_impact: co.total, effective_at: co.accepted_at, pdf_path: '',
          })
          if (insErr) throw new Error(`insert amendment: ${insErr.message}`)
          await record('co', co.workspace_id, co.id, co.title, 'amendment_created', { financial_impact: co.total })
        }
      }
      if (!co.content_hash) report.unrepairable.push(`${label}: accepted without a content_hash`)
      if (!co.pdf_path) report.unrepairable.push(`${label}: accepted without a frozen executed PDF`)
    } catch (e: any) {
      report.failures.push(`${label}: ${e?.message || String(e)}`)
    }
  }

  return report
}

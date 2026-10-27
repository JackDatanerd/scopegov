// lib/integrations/enrich.ts
//
// Turns the bare document reference a notification site passes (`data.document = { type, id }`) into the fields a
// Zap or webhook can actually use: number, title, status, amounts, dates. Done by the DELIVERY worker, in one batched
// query per document type, so the ~20 notification sites only supply ids they already hold and none of their own
// queries had to change.
//
// Safety:
//   • each row must belong to the event's own workspace (milestones: the event's project) — a mismatched reference is
//     dropped, never trusted;
//   • only the event's OWN document type is ever loaded, so a SOW event cannot leak invoice amounts (the permission
//     rule is per event: see permissionForEvent);
//   • best effort — a failed lookup sends the event with just {type, id} rather than failing or delaying it.
// Values are as of DELIVERY time (usually within a minute of the event).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)
const clip = (v: unknown, n = 500) => (typeof v === 'string' ? (v.length > n ? v.slice(0, n) + '…' : v) : null)

interface Spec {
  table: string
  select: string
  /** The row must carry this workspace/project ownership to be used. */
  owner: { column: 'workspace_id' | 'project_id'; matches: (event: any) => string | null }
  shape: (row: any, ctx: { currency: string | null }) => Record<string, unknown>
}

const byWorkspace = { column: 'workspace_id' as const, matches: (e: any) => e.workspace_id }

export const DOCUMENT_SPECS: Record<string, Spec> = {
  sow: {
    table: 'sow_documents', owner: byWorkspace,
    select: 'id, workspace_id, document_number, version, status, sent_at, signed_at, expires_at',
    shape: r => ({ number: r.document_number ?? null, version: r.version ?? null, status: r.status ?? null, sent_at: r.sent_at ?? null, signed_at: r.signed_at ?? null, expires_at: r.expires_at ?? null }),
  },
  change_order: {
    table: 'change_orders', owner: byWorkspace,
    select: 'id, workspace_id, document_number, title, version, status, total, is_credit, is_retainer_renewal, sent_at, accepted_at, expires_at',
    shape: (r, c) => ({ number: r.document_number ?? null, title: r.title ?? null, version: r.version ?? null, status: r.status ?? null, total: num(r.total), currency: c.currency, is_credit: !!r.is_credit, is_retainer_renewal: !!r.is_retainer_renewal, sent_at: r.sent_at ?? null, accepted_at: r.accepted_at ?? null, expires_at: r.expires_at ?? null }),
  },
  invoice: {
    table: 'invoices', owner: byWorkspace,
    select: 'id, workspace_id, invoice_number, title, status, amount, amount_paid, currency, due_date, sent_at, paid_at',
    shape: r => ({
      number: r.invoice_number ?? null, title: r.title ?? null, status: r.status ?? null, amount: num(r.amount), amount_paid: num(r.amount_paid),
      balance_due: num(r.amount) === null ? null : Math.max(0, (num(r.amount) || 0) - (num(r.amount_paid) || 0)),
      currency: r.currency ?? null, due_date: r.due_date ?? null, sent_at: r.sent_at ?? null, paid_at: r.paid_at ?? null,
    }),
  },
  payment_milestone: {
    table: 'payment_milestones', owner: { column: 'project_id', matches: e => e.project_id },
    select: 'id, project_id, title, amount, due_date, status, type',
    shape: (r, c) => ({ title: r.title ?? null, amount: num(r.amount), currency: c.currency, due_date: r.due_date ?? null, status: r.status ?? null, milestone_type: r.type ?? null }),
  },
  guardian_flag: {
    table: 'guardian_flags', owner: byWorkspace,
    select: 'id, workspace_id, severity, status, type, description, sow_reference, created_at',
    shape: r => ({ severity: r.severity ?? null, status: r.status ?? null, flag_type: r.type ?? null, description: clip(r.description), sow_reference: r.sow_reference ?? null, raised_at: r.created_at ?? null }),
  },
}

export type DocumentIndex = Map<string, Record<string, unknown>>
const keyOf = (type: string, id: string) => `${type}:${id}`

/** Look up every distinct document referenced by `events` (grouped by type). Never throws. */
export async function loadDocuments(service: any, events: any[], projectCurrency: (projectId: string | null) => string | null): Promise<DocumentIndex> {
  const out: DocumentIndex = new Map()
  const wanted = new Map<string, Set<string>>()
  for (const e of events) {
    const d = e?.data?.document
    if (d && typeof d.type === 'string' && DOCUMENT_SPECS[d.type] && typeof d.id === 'string' && UUID.test(d.id)) {
      if (!wanted.has(d.type)) wanted.set(d.type, new Set())
      wanted.get(d.type)!.add(d.id)
    }
  }
  await Promise.all(Array.from(wanted.entries()).map(async ([type, ids]) => {
    const spec = DOCUMENT_SPECS[type]
    try {
      const { data, error } = await service.from(spec.table).select(spec.select).in('id', Array.from(ids))
      if (error) throw new Error(error.message)
      const rows = new Map<string, any>((data || []).map((r: any) => [r.id, r]))
      for (const e of events) {
        const d = e?.data?.document
        if (!d || d.type !== type) continue
        const row = rows.get(d.id)
        if (!row) continue
        if (row[spec.owner.column] !== spec.owner.matches(e)) continue // not this event's workspace/project: refuse
        out.set(`${e.id}|${keyOf(type, d.id)}`, { type, id: d.id, ...spec.shape(row, { currency: projectCurrency(e.project_id || null) }) })
      }
    } catch (err: any) {
      console.error(`[integrations] ${type} lookup failed (sending without details):`, err?.message || err)
    }
  }))
  return out
}

/** The event's data with `document` replaced by its looked-up details when available (else the bare reference). */
export function withDocument(event: any, index: DocumentIndex): Record<string, unknown> {
  const data = { ...(event.data || {}) }
  const d = data.document
  if (d && typeof d.type === 'string' && typeof d.id === 'string') {
    data.document = index.get(`${event.id}|${keyOf(d.type, d.id)}`) || { type: d.type, id: d.id }
  }
  return data
}

// lib/documents/tax-basis.ts
//
// ONE tax basis per engagement: the one the SOW states. A SOW, its change orders and its invoices used to each pick tax on their
// own (the SOW from the workspace default at the moment it was drafted, a change order or invoice from the workspace default or
// from whatever the person chose on that form). So one engagement could say nothing about tax in the contract, "plus 8.25%" on one
// document and "includes 8.25%" on another, and the contract position then treated a tax-inclusive fee as if it were pre-tax.
//
// The basis a later document starts from is, in order: the engagement's SOW (a signed one first), else the workspace default.
// It is a STARTING value: a person can still change it on a form, but they now start from what was agreed.

export interface TaxBasis { taxRate: number; taxInclusive: boolean }

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** A value expressed before tax. Inclusive: the value contains the tax, so it is divided out. Exclusive/none: unchanged. */
export function netOfTax(value: number, basis: TaxBasis | null | undefined): number {
  if (!Number.isFinite(value)) return value
  if (!basis || !(basis.taxRate > 0) || basis.taxInclusive !== true) return value
  return round2(value / (1 + basis.taxRate / 100))
}

type SowRow = { status?: string | null; metadata?: Record<string, unknown> | null } | null | undefined
const LIVE = new Set(['draft', 'awaiting_signature', 'changes_requested'])

function basisOf(row: SowRow): TaxBasis | null {
  const m = row?.metadata
  const rate = Number(m?.taxRate)
  if (!(rate > 0 && rate <= 100)) return null
  return { taxRate: rate, taxInclusive: typeof m?.taxInclusive === 'boolean' ? (m.taxInclusive as boolean) : true }
}

/** From SOW rows NEWEST FIRST: the latest signed SOW that states tax, else the latest live one that does. Null = none states tax. */
export function pickTaxBasis(sowsNewestFirst: SowRow[]): TaxBasis | null {
  for (const r of sowsNewestFirst || []) if (r?.status === 'signed') { const b = basisOf(r); if (b) return b }
  for (const r of sowsNewestFirst || []) if (r?.status && LIVE.has(r.status)) { const b = basisOf(r); if (b) return b }
  return null
}

/** The tax basis of each project's SOW. A failed read is an empty map (a display path must not break); `strict` throws instead. */
export async function projectTaxBases(service: any, projectIds: string[], opts: { strict?: boolean } = {}): Promise<Map<string, TaxBasis>> {
  const out = new Map<string, TaxBasis>()
  if (!projectIds.length) return out
  try {
    const { data, error } = await service.from('sow_documents')
      .select('project_id, status, metadata, created_at').in('project_id', projectIds)
    if (error) throw new Error(error.message)
    // Newest first, sorted here rather than in the query so a project's SOW history is read in one plain request.
    const rows = [...(data || [])].sort((a: any, b: any) => String(b?.created_at ?? '').localeCompare(String(a?.created_at ?? '')))
    const byProject = new Map<string, SowRow[]>()
    for (const r of rows) {
      const list = byProject.get(r.project_id) || []
      list.push(r); byProject.set(r.project_id, list)
    }
    for (const [id, rows] of byProject) { const b = pickTaxBasis(rows); if (b) out.set(id, b) }
  } catch (err) {
    if (opts.strict) throw err instanceof Error ? err : new Error(String(err))
    console.error('[tax-basis] SOW tax lookup failed (continuing without it):', err instanceof Error ? err.message : err)
  }
  return out
}

export async function projectTaxBasis(service: any, projectId: string, opts: { strict?: boolean } = {}): Promise<TaxBasis | null> {
  return (await projectTaxBases(service, [projectId], opts)).get(projectId) ?? null
}

/**
 * Tax terms a caller states explicitly (the new-project wizard asks, so the contract can say so from the first draft).
 * `value` undefined = not stated (fall back to the workspace default); a stated 0% is "no tax", inclusive meaningless.
 */
export function parseStatedTax(rate: unknown, inclusive: unknown): { ok: true; value: TaxBasis | undefined } | { ok: false; error: string } {
  if (rate === undefined || rate === null || rate === '') return { ok: true, value: undefined }
  const n = typeof rate === 'number' ? rate : typeof rate === 'string' ? Number(rate) : NaN
  if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, error: 'Tax rate must be a number from 0 to 100' }
  if (n === 0) return { ok: true, value: { taxRate: 0, taxInclusive: false } }
  return { ok: true, value: { taxRate: Math.round(n * 1000) / 1000, taxInclusive: inclusive !== false } }
}

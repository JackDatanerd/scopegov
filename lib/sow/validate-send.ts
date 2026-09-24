// lib/sow/validate-send.ts
//
// Everything that must be true of a SOW before it can go in front of a client,
// in ONE place. It used to live inline in app/api/sow/[id]/send/route.ts, so the
// approval-chain auto-send (lib/approvals/engine.ts -> sendSowDocument) skipped
// every check: a SOW whose contract value, schedule or sections changed while it
// sat in an approval queue went out unvalidated.
//
//   errors   — hard blocks; the SOW must not be sent.
//   warnings — things worth a human's second look (e.g. the Payment Terms text does
//              not state the contract value). The send route asks the sender to
//              acknowledge them; the unattended approval path treats them as
//              non-blocking.

import { parseTableAmount, isTableSection } from '@/lib/sow/table-schema'
import { roundCurrency } from '@/lib/utils/format'

export interface SowSendValidation {
  errors: string[]
  warnings: string[]
}

function textOf(html: unknown): string {
  return String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Every numeric amount mentioned in a block of prose. */
export function amountsMentioned(text: string): number[] {
  const tokens = text.match(/\d[\d.,'\u2019\u00a0\u202f ]*\d|\d/g) || []
  const out: number[] = []
  for (const t of tokens) {
    const n = parseTableAmount(t)
    if (n !== null) out.push(n)
  }
  return out
}

export function validateSowForSend(input: {
  sections: any[]
  metadata: any
  contractValue: number | null | undefined
}): SowSendValidation {
  const errors: string[] = []
  const warnings: string[] = []
  const sections: any[] = Array.isArray(input.sections) ? input.sections : []
  const contractValue = Number(input.contractValue)
  const byId = (id: string) => sections.find(s => s?.id === id)

  if (!Number.isFinite(contractValue) || contractValue <= 0)
    errors.push('Set a contract value greater than zero before sending this SOW.')

  const hasVisibleContent = sections.some(s =>
    s?.visible !== false &&
    (textOf(s?.content).length > 0 || (Array.isArray(s?.table) && s.table.length > 0)))
  if (!hasVisibleContent)
    errors.push('Add at least one visible section before sending this SOW.')

  // Load-bearing sections must actually say something. (The editor already refuses
  // to hide them; this refuses to send them empty.)
  const deliverables = byId('deliverables')
  const deliverableRows = (Array.isArray(deliverables?.table) ? deliverables.table : [])
    .filter((r: any) => String(r?.deliverable ?? '').trim())
  if (deliverableRows.length === 0)
    errors.push('List at least one deliverable before sending this SOW.')
  if (!textOf(byId('oos')?.content))
    errors.push('Fill in the Out of Scope section before sending this SOW — it is what protects both sides from scope creep. Write "None" if nothing is excluded.')
  if (!textOf(byId('payment')?.content))
    errors.push('Fill in the Payment Terms section before sending this SOW.')

  // FIX (section-9 re-audit, independent pass): 'parties', 'governing_law' and
  // 'signature' are in REQUIRED_SECTION_IDS (lib/sow/sections.ts) — the editor
  // refuses to HIDE them — but nothing ever refused to send them EMPTY. All
  // three are boilerplate the agency can freely edit via the generic
  // content-edit path (PATCH /api/sow/[id]), which only caps max length, never
  // enforces a minimum. governing_law is the most material of the three: this
  // app hard-blocks generation entirely when workspaces.governing_law is unset
  // ("a real, material legal term of the contract" — see api/sow/generate),
  // yet a signed document could still carry a completely blank Governing Law
  // section — visibly broken too, since it renders through the same numbered
  // SowSection/RichText path as every other prose section, which prints
  // nothing under the heading when content is empty (the exact "floating
  // heading" failure class SowTable already got a placeholder for, just never
  // extended to prose). Same treatment as oos/payment above.
  if (!textOf(byId('parties')?.content))
    errors.push('Fill in the Parties section before sending this SOW.')
  if (!textOf(byId('governing_law')?.content))
    errors.push('Fill in the Governing Law section before sending this SOW.')
  if (!textOf(byId('signature')?.content))
    errors.push('Fill in the Signature section before sending this SOW.')

  // Payment Terms is authored prose; the contract value is data. Nothing else ties
  // them together, and a contract value edited after generation leaves the old
  // figure printed in the signed document.
  const paymentText = textOf(byId('payment')?.content)
  if (paymentText && Number.isFinite(contractValue) && contractValue > 0) {
    const mentioned = amountsMentioned(paymentText)
    const states = mentioned.some(n => Math.abs(n - contractValue) < 0.01)
    if (!states) {
      warnings.push(
        `The Payment Terms text does not state the contract value (${contractValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}). ` +
        'If the value changed after this SOW was written, update that section (or regenerate it) so the signed document agrees with itself.'
      )
    }
  }

  // Milestone structure: the schedule is part of the agreement and has to foot.
  if (input.metadata?.paymentStructure === 'milestones') {
    const schedule = byId('payment_schedule')
    const rows: any[] = Array.isArray(schedule?.table) && isTableSection('payment_schedule') ? schedule.table : []
    const parsed = rows.map(r => ({
      milestone: String(r?.milestone || '').trim(),
      amount: parseTableAmount(r?.amount),
    }))
    const unreadable = parsed.filter(r => r.milestone && r.amount === null)
    if (unreadable.length > 0) {
      errors.push(`Couldn't read the amount on the Payment Schedule milestone "${unreadable[0].milestone}". Enter a plain number.`)
    } else {
      // FIX (fix round, SOW-B3): this used to only count rows with a strictly
      // positive amount, silently dropping any zero or negative (e.g. a
      // legitimate "credit"/discount milestone) row from both the "at least one
      // milestone" check and the footing sum. That let the editor's own running
      // total (which — correctly — includes every named row regardless of sign)
      // show "Matches the contract value" while this check computed a different
      // total and rejected the send. Now every named, readable row counts,
      // matching SowEditor.tsx's scheduleTotal exactly.
      const validRows = parsed.filter(r => r.milestone)
      if (validRows.length === 0) {
        errors.push('Add at least one milestone to the Payment Schedule before sending this SOW.')
      } else if (schedule?.visible === false) {
        errors.push('This SOW uses a milestone payment structure — un-hide the Payment Schedule section before sending it.')
      } else if (Number.isFinite(contractValue)) {
        const sum = roundCurrency(validRows.reduce((s, r) => s + (r.amount ?? 0), 0))
        if (Math.abs(sum - contractValue) >= 0.01)
          errors.push(`The Payment Schedule totals ${sum.toFixed(2)} but the contract value is ${contractValue.toFixed(2)} — these must match before sending.`)
      }
    }
  }

  return { errors, warnings }
}

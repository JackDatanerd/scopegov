// lib/documents/tax-basis-gap.ts
//
// Pre-send check: does this invoice / change order treat tax the way the engagement's SOW states it?
//
// An engagement has ONE tax basis (lib/documents/tax-basis.ts): the SOW says either "X% is added on top of the fee" or "the fee includes
// X%". Invoices and change orders START from that basis but stay editable, so a person can flip "tax included" on one of them and the
// documents then disagree about the same money (a 1,200 fee invoiced as 1,200 total when the signed SOW says 1,299 with tax). Nothing
// said so. This returns an acknowledgeable warning (never a hard block: the SOW may genuinely have been wrong) the send routes show.

import { projectTaxBasis, type TaxBasis } from '@/lib/documents/tax-basis'

export type TaxDocKind = 'invoice' | 'change order'

const fmtRate = (n: number) => String(Math.round(n * 1000) / 1000)

/** Pure comparison. `sow` null (no SOW states tax) never warns: there is nothing agreed to disagree with. */
export function taxBasisMismatch(kind: TaxDocKind, doc: { taxRate: number; taxInclusive: boolean }, sow: TaxBasis | null): string | null {
  if (!sow || !(sow.taxRate > 0)) return null
  const sameRate = Math.abs(doc.taxRate - sow.taxRate) < 0.0005
  const rate = doc.taxRate > 0 ? doc.taxRate : 0
  if (sameRate && doc.taxInclusive === sow.taxInclusive) return null
  const sowSays = sow.taxInclusive
    ? `the fee includes ${fmtRate(sow.taxRate)}% sales tax`
    : `${fmtRate(sow.taxRate)}% sales tax is added on top of the fee`
  const docDoes = !(rate > 0)
    ? `has no tax on it`
    : doc.taxInclusive
      ? `treats the amounts as including ${fmtRate(rate)}% tax`
      : `adds ${fmtRate(rate)}% tax on top of the amounts`
  return `The signed SOW states that ${sowSays}, but this ${kind} ${docDoes}. The client would be billed a different total than the SOW implies. Fix the tax setting on the ${kind}, or send it as it is.`
}

export async function loadTaxBasisWarning(
  service: any, projectId: string | null | undefined, kind: TaxDocKind, doc: { taxRate: unknown; taxInclusive: unknown },
): Promise<string | null> {
  if (!projectId) return null
  try {
    const sow = await projectTaxBasis(service, projectId)
    const rate = Number(doc.taxRate)
    return taxBasisMismatch(kind, { taxRate: Number.isFinite(rate) ? rate : 0, taxInclusive: doc.taxInclusive === true }, sow)
  } catch {
    return null // a courtesy check: never block a send because it could not run
  }
}

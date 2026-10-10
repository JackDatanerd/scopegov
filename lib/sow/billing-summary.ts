// lib/sow/billing-summary.ts
//
// One plain sentence saying what the number the person typed MEANS. The same figure is a whole project's price on a fixed project
// and one month's fee on a retainer; a field labelled "Contract value" let "$1,200" for a monthly engagement be read, stored and
// printed as a $1,200 project. Shown beside the amount (basics), where it is asked for again (brief) and on the review step, so
// the meaning is in front of the person every time the amount is, in the same words.

export interface BillingSummaryInput {
  monthly: boolean
  amount: number | string | null | undefined
  currency: string
  /** Retainer term in months; null/0/undefined = open-ended. Ignored for a fixed project. */
  termMonths?: number | string | null
}

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function describeBilling(input: BillingSummaryInput): string {
  const amount = Number(input.amount)
  const months = Number(input.termMonths)
  const term = Number.isInteger(months) && months > 0 ? months : null
  const cur = input.currency || ''
  if (!Number.isFinite(amount) || amount <= 0)
    return input.monthly ? 'Enter the fee for one month. It is invoiced every month.' : 'Enter the price of the whole project.'
  if (!input.monthly) return `The whole project is ${cur} ${money(amount)}, invoiced as one fee or in instalments.`
  const total = Math.round(amount * (term || 0) * 100) / 100
  return term
    ? `${cur} ${money(amount)} is invoiced every month for ${term} month${term === 1 ? '' : 's'}, ${cur} ${money(total)} in total.`
    : `${cur} ${money(amount)} is invoiced every month until the retainer ends. There is no fixed total.`
}

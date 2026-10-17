// lib/sow/display-rows.ts
//
// Payment schedule rows are stored as the agency or the drafter wrote them ("Monthly retainer", "Upfront payment (50%)") but every
// document title is printed in Title Case in English. The PDF and the portal page read this one function, so the same row reads
// the same way on paper and on screen. Display only: stored rows are never rewritten.

import { toTitleCaseFor } from '@/lib/documents/title-case'

export function displayTableRows<T extends Record<string, any>>(sectionId: string, rows: T[] | null | undefined, language: string | null | undefined): T[] {
  const list = (rows || []) as T[]
  if (sectionId !== 'payment_schedule') return list
  return list.map(r => (typeof r?.milestone === 'string' ? { ...r, milestone: toTitleCaseFor(r.milestone, language) } : r))
}

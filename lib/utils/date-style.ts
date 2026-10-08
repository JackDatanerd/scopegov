// lib/utils/date-style.ts
//
// One decision, made in one place, about how English calendar dates read in a document: "June 16, 2026" for a US
// agency, "16 June 2026" everywhere else. The SOW prompt (lib/ai/sow-content.ts) and the PDF renderer
// (lib/pdf/renderer.tsx) both use it, so dates the model writes in prose and dates the renderer prints never
// disagree on the same document.

export type DateStyle = 'us' | 'intl'

const US_COUNTRY = /^(us|u\.s\.|u\.s\.a\.?|usa|united states( of america)?)$/i

export function dateStyleForCountry(country: string | null | undefined): DateStyle {
  return typeof country === 'string' && US_COUNTRY.test(country.trim()) ? 'us' : 'intl'
}

/** From a workspace's legal_address (jsonb) — anything unreadable is the international style. */
export function sowDateStyle(legalAddress: { country?: string | null } | null | undefined): DateStyle {
  return dateStyleForCountry(legalAddress?.country)
}

/** The Intl locale for an English document in this style. */
export function englishDateLocale(style: DateStyle): string {
  return style === 'us' ? 'en-US' : 'en-GB'
}

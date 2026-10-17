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

const DOC_LANGUAGE_LOCALES: Record<string, string> = { es: 'es', fr: 'fr', pt: 'pt', de: 'de', sw: 'sw' }

/**
 * The Intl locale a document prints calendar dates in: the drafting language's own for a non-English SOW, otherwise the English style
 * of the agency's country. The PDF renderer and the portal pages both use it, so one document reads one way on screen and on paper.
 */
export function documentDateLocale(language: string | null | undefined, country: string | null | undefined): string {
  return (language && DOC_LANGUAGE_LOCALES[language]) || englishDateLocale(dateStyleForCountry(country))
}

// lib/documents/defined-terms.ts
//
// The SOW's Parties clause defines three terms: "SOW", "Provider" and "Client". The model sometimes writes "the Services" as if it were a
// fourth, but nothing ever defines it, so a capitalised term appears in a contract with no meaning. Where nothing defines it, it is
// ordinary lower case ("the services"). Where the text does define it (a definition the agency added), it is left alone.

/** True when any of the texts defines "Services" as a term, e.g. (the "Services") or "Services" means ... */
export function servicesIsDefined(texts: Array<string | null | undefined>): boolean {
  const all = texts.map(t => String(t ?? '').replace(/<[^>]+>/g, ' ')).join(' ')
  const q = `["\u201c\u2018']`, qe = `["\u201d\u2019']`
  return new RegExp(`\\(\\s*(?:the\\s+)?${q}Services${qe}\\s*\\)|${q}Services${qe}\\s+(?:means|shall mean|is defined|has the meaning)|\\bdefined as\\b[^.]{0,80}${q}Services${qe}`, 'i').test(all)
}

/** "the Services" / "The Services" -> "the services" / "The services"; "The Services Company" (a name) is left alone. */
export function lowerUndefinedServices(text: string): string {
  return String(text ?? '').replace(/\b([Tt]he) Services\b(?!\s+[A-Z])/g, '$1 services')
}

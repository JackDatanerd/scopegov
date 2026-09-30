// lib/reports/portfolio-client-groups.ts
//
// The Portfolio's "Projects by risk → By client" roll-up, as a pure function so it can be tested.
//
// FIX (Portfolio independent pass 6): this used to live inline in PortfolioDashboard.tsx and had two defects.
//  1. It grouped on the client's NAME. Clients are unique per workspace by email
//     (clients_workspace_email_lower), not by name, so two distinct "Acme" clients are legal — and their flags,
//     stuck documents and value at risk were summed into a single row, hiding that one of them is the problem.
//     Groups are now keyed on the client id (falling back to the name only for a payload that predates
//     `clientId`). Clients that genuinely share a display name are told apart with a stable "(#n)" suffix.
//  2. It ordered groups by a sum of value-at-risk ACROSS currencies — the cross-currency arithmetic the rest of
//     the Portfolio deliberately never does (a KES 500,000 client beat a USD 20,000 one because the number is
//     bigger). Groups are now ordered by exposure in the workspace's headline currency, then open flags; money is
//     still shown per currency and never summed across them.

export interface ClientRiskInputRow {
  clientId?: string | null
  clientName: string | null
  currency: string
  openFlags: number
  highFlags: number
  stuckDocs: number
  /** Null when the viewer lacks VIEW_FINANCIALS. */
  atRisk: number | null
}

export interface ClientRiskGroup {
  /** Stable React key / identity of the group. */
  key: string
  /** Display label — disambiguated when two clients share a name. */
  client: string
  projects: number
  openFlags: number
  highFlags: number
  stuckDocs: number
  /** Value at risk per currency, headline currency first, then alphabetical. Empty without VIEW_FINANCIALS. */
  risk: Array<[string, number]>
}

export function groupRiskByClient(rows: ClientRiskInputRow[], headlineCurrency: string): ClientRiskGroup[] {
  interface Acc { key: string; name: string; projects: number; openFlags: number; highFlags: number; stuckDocs: number; risk: Map<string, number> }
  const map = new Map<string, Acc>()
  for (const r of rows) {
    const key = r.clientId ? `id:${r.clientId}` : r.clientName ? `name:${r.clientName}` : 'none'
    const g = map.get(key) || {
      key,
      name: r.clientName || (r.clientId ? 'Unnamed client' : 'No client'),
      projects: 0, openFlags: 0, highFlags: 0, stuckDocs: 0, risk: new Map<string, number>(),
    }
    g.projects++; g.openFlags += r.openFlags; g.highFlags += r.highFlags; g.stuckDocs += r.stuckDocs
    if (r.atRisk !== null) g.risk.set(r.currency, (g.risk.get(r.currency) || 0) + r.atRisk)
    map.set(key, g)
  }

  // Two different clients with the same display name: number them in a stable order (by key, not by the
  // exposure sort below, so a label never changes when the ranking does).
  const byName = new Map<string, Acc[]>()
  for (const g of Array.from(map.values())) byName.set(g.name, [...(byName.get(g.name) || []), g])
  const labels = new Map<string, string>()
  for (const [name, list] of Array.from(byName.entries())) {
    if (list.length === 1) { labels.set(list[0].key, name); continue }
    list.sort((a, b) => a.key.localeCompare(b.key)).forEach((g, i) => labels.set(g.key, `${name} (#${i + 1})`))
  }

  const headline = (g: Acc) => g.risk.get(headlineCurrency) || 0
  return Array.from(map.values())
    .sort((a, b) => headline(b) - headline(a) || b.openFlags - a.openFlags || b.highFlags - a.highFlags
      || (labels.get(a.key) as string).localeCompare(labels.get(b.key) as string) || a.key.localeCompare(b.key))
    .map(g => ({
      key: g.key,
      client: labels.get(g.key) as string,
      projects: g.projects, openFlags: g.openFlags, highFlags: g.highFlags, stuckDocs: g.stuckDocs,
      risk: Array.from(g.risk.entries()).sort(([a], [b]) =>
        (a === headlineCurrency ? -1 : b === headlineCurrency ? 1 : a.localeCompare(b))),
    }))
}

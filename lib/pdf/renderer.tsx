// lib/pdf/renderer.ts
// FIX 4B: Replaced Puppeteer/Chromium with @react-pdf/renderer.
// Pure Node.js — no browser, no timeout risk on Vercel Hobby.
// npm install @react-pdf/renderer

import React from 'react'
import {
  Document, Page, View, Text, Image, Link,
  StyleSheet, renderToBuffer,
} from '@react-pdf/renderer'
import { safeFetch } from '@/lib/utils/safe-fetch'
import { RichText } from '@/lib/pdf/rich-text'
import { SowTable } from '@/lib/pdf/sow-table'
import { isTableSection, milestoneBlockLabels, type SowTableRow } from '@/lib/sow/table-schema'
import { formatAddressLines, type LegalAddress } from '@/lib/utils/format'
import { PDF_FONT, sanitizeForPdf } from '@/lib/pdf/fonts'
import { mapPdfSymbols } from '@/lib/pdf/pdf-symbols'

// Phase 11: the ScopeGov credit in the footer of every document is a real
// hyperlink now, not plain text — same URL everywhere so it's one place to
// change if the marketing site ever moves.
const SCOPEGOV_URL = 'https://scopegov.app'

// Printed on SOW/CO/Invoice PDFs as the agency's "From" address and the
// client's "Bill To" address. Every field optional — a party with no
// address on file just doesn't get an address block, the document still
// renders fine (see formatAddress below).
function formatAddress(a: LegalAddress | null | undefined): string[] {
  return formatAddressLines(a)
}

export interface SowPdfData {
  agencyName:    string
  agencyLogoUrl: string | null
  brandColour:   string
  agencyAddress?: LegalAddress | null
  agencyTaxId?:   string | null
  agencyPhone?:   string | null
  agencyWebsite?: string | null
  clientName:    string
  clientCompany?: string | null
  clientBillingAddress?: LegalAddress | null
  clientVatNumber?: string | null
  projectName:   string
  contractValue: number
  currency:      string
  sections:      Array<{ id: string; title: string; content: string; table?: SowTableRow[]; visible: boolean; order: number }>
  // FIX (section-9 audit, 9-G7): the SOW's drafting language, from
  // sow_documents.metadata.language. Section titles are already stored
  // localized; the table column headers are schema-driven and need this
  // to resolve. Absent/'en' renders exactly as before.
  language?:     string
  paymentSchedule?: Array<{ title: string; amount: number; percentage: number | null; trigger: string; dueDate: string | null; status: string }>
  signedBy?:     string
  signedAt?:     string
  agencySignatureData?: string | null
  clientSignatureData?: string | null
  version:       number
  isWatermarked?: boolean
  documentNumber?: string | null
  // Optional one-line cross-reference to a governing Master Service
  // Agreement, e.g. "Issued under the Master Service Agreement dated
  // March 3, 2026." Sourced from sow_documents.metadata.msaReference —
  // no dedicated settings field exists for this yet, so it only renders
  // when explicitly present. Renders under the masthead, same placement
  // pattern as a firm-issued SOW referencing its parent MSA.
  msaReference?: string | null
}

export interface CoPdfData {
  agencyName:   string
  logoUrl:      string | null
  brandColour:  string
  agencyAddress?: LegalAddress | null
  agencyTaxId?:   string | null
  agencyPhone?:   string | null
  agencyWebsite?: string | null
  clientName:   string
  clientCompany?: string | null
  clientBillingAddress?: LegalAddress | null
  clientVatNumber?: string | null
  projectName:  string
  coTitle:      string
  note:         string | null
  lineItems:    Array<{ description: string; quantity: number; rate: number; total: number }>
  subtotal:     number
  taxRate:      number
  taxInclusive: boolean
  total:        number
  currency:     string
  // FIX (doc-quality audit round 2): status was previously implied only
  // by whether acceptedAt was set — a CO sent for review and still
  // awaiting a client response rendered with no status indicator at all,
  // unlike a firm-issued CO which always shows a clear "PENDING APPROVAL"
  // badge. Optional so existing callers that haven't been updated yet
  // don't break; the badge simply doesn't render without it.
  status?:      string
  isWatermarked?: boolean
  acceptedBy?:  string
  acceptedAt?:  string
  agencySignatureData?: string | null
  clientSignatureData?: string | null
  isPartial?:   boolean
  partialNote?: string
  documentNumber?: string | null
  // "Amends SOW No. X" cross-reference — the SOW this CO modifies.
  // Resolved by the caller from the project's current signed SOW (there's
  // no direct FK from change_orders to sow_documents), so it's best-effort
  // and simply omitted if the project has no signed SOW on file.
  sowNumber?:   string | null
  // Original/Revised contract value block (Meridian's "Impact Analysis"
  // equivalent). contractValueBefore is the project's base contract value
  // plus every OTHER previously-accepted CO's amount — see
  // lib/documents/co-contract-value.ts, which both PDF routes now compute
  // this from (FIX, portal audit section 18: the old inline version here
  // assumed contract_value itself already accumulated prior COs, which it
  // never has — that's tracked in the separate `amendments` table instead).
  contractValueBefore?: number | null
  // Retainer renewal: the CO REPLACES the monthly rate rather than adding to a contract value, so the
  // Impact block shows current → new rate instead of "original + this change order".
  isRetainerRenewal?: boolean
  revisedContractValue?: number | null
  // Scope/Timeline impact rows (doc-quality audit round 3, migration
  // 018) — Meridian's Impact Analysis shows Scope / Timeline / Value as
  // three before-and-after rows; this was value-only until now. Both
  // optional and independent of contractValueBefore — a CO can state a
  // scope change with no financial impact, or vice versa.
  timelineImpactDays?: number | null
  scopeImpactNote?:    string | null
}

export interface InvoicePdfData {
  agencyName:   string
  logoUrl:      string | null
  brandColour:  string
  agencyAddress?: LegalAddress | null
  agencyTaxId?:   string | null
  agencyPhone?:   string | null
  agencyWebsite?: string | null
  clientName:   string
  clientCompany?: string | null
  clientBillingAddress?: LegalAddress | null
  clientVatNumber?: string | null
  poNumber?:    string | null
  milestoneTrigger?: string | null
  projectName:  string
  invoiceNumber?: string | null
  title:        string
  amount:       number
  amountPaid:   number
  // FIX (doc-completeness audit, finding #2): invoices had no tax
  // breakdown at all even though the invoice already prints the client's
  // VAT number. `subtotal` is only meaningful when taxRate > 0 —
  // undefined/0 means this invoice predates or doesn't use tax.
  subtotal?:    number | null
  taxRate?:     number
  taxInclusive?: boolean
  currency:     string
  status:       string
  dueDate?:     string | null
  sentAt?:      string | null
  paymentInstructions?: string | null
  payments:     Array<{ amount: number; paidAt: string; method: string; referenceNote?: string | null }>
  contractPosition?: { contractedValue: number; invoicedToDate: number; paidToDate: number } | null
  // Cross-references (doc-quality audit round 2) — the underlying
  // sow_id/co_id FKs already existed on `invoices`, just weren't being
  // read into the PDF. Mirrors Meridian sample's "For services rendered
  // under SOW No. X" / "as amended by Change Order No. Y" lines.
  sowNumber?:   string | null
  coNumber?:    string | null
  coTitle?:     string | null
  // Optional itemized breakdown (migration 017). Empty/undefined falls
  // back to the existing single-line title+amount display — every
  // invoice created before this pass keeps rendering exactly as before.
  lineItems?:   Array<{ description: string; quantity: number; rate: number; total: number }>
}

// Resolve logo URL to base64 data URI for embedding in the PDF
//
// FIX (audit round 1): this used a raw fetch(url) with no SSRF guard —
// no scheme allowlist, no private/internal IP blocking, and it followed
// redirects automatically. Every caller today only ever passes a URL
// built from Supabase Storage's own getPublicUrl(), so this wasn't
// reachable with an attacker-chosen host in practice — but it's a
// shared primitive, not a one-off, so it gets the same SSRF guard
// (safeFetch) as any other server-side fetch of a URL that ultimately
// traces back to workspace-controlled data, same bug class as the
// PDF-logo SSRF already fixed in ScopeShield.
export async function resolveLogoDataUri(url: string | null | undefined): Promise<string | null> {
  if (!url) return null
  if (url.startsWith('data:')) return url
  try {
    const res  = await safeFetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const buf  = await res.arrayBuffer()
    const mime = res.headers.get('content-type') ?? 'image/png'
    return `data:${mime};base64,${Buffer.from(buf).toString('base64')}`
  } catch { return null }
}

// Strip HTML tags from editor content for PDF text rendering
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '$1')
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

// Whole amounts print without decimals ("1,500"); anything with cents always prints BOTH digits
// ("1,500.50", not "1,500.5" — a contract figure reading as 1,500.5 looks like a typo).
function fmtMoney(n: number) {
  const whole = Math.round(n * 100) % 100 === 0
  return n.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })
}

const hasRichText = (html?: string | null) => !!html && html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().length > 0

// ── SOW PDF ──────────────────────────────────────────────────

function SowSection({ sec, num, s, language }: { sec: SowPdfData['sections'][number]; num: number; s: any; language?: string }) {
  return (
    <View style={s.section} wrap={isTableSection(sec.id) ? undefined : false}>
      <Text style={s.secTitle}><Text style={s.secNum}>{num}. </Text>{sec.title}</Text>
      {isTableSection(sec.id)
        ? <SowTable sectionId={sec.id} rows={sec.table || []} language={language} />
        : <RichText html={sec.content} style={s.body} />}
    </View>
  )
}

function SowDocument({ data, logo }: { data: SowPdfData; logo: string | null }) {
  const c = data.brandColour || '#1A5C3A'

  const s = StyleSheet.create({
    page:       { fontFamily: PDF_FONT.sans, fontSize: 10, color: '#1A1A1A', padding: '40 48' },
    // Header
    header:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: `2 solid ${c}`, paddingBottom: 14, marginBottom: 20 },
    h1:         { fontFamily: PDF_FONT.bold, fontSize: 18, color: c, marginBottom: 3 },
    meta:       { fontSize: 8.5, color: '#909090' },
    logo:       { maxHeight: 42, maxWidth: 100, objectFit: 'contain' },
    agencyText: { fontFamily: PDF_FONT.bold, fontSize: 11, color: c },
    valueLabel: { fontSize: 8, color: '#909090', textTransform: 'uppercase', letterSpacing: 0.5, textAlign: 'right' },
    value:      { fontSize: 16, color: c, textAlign: 'right', fontFamily: PDF_FONT.bold },
    // Parties
    partiesBox: { flexDirection: 'row', gap: 32, backgroundColor: '#F9F8F5', border: `1 solid #E5E1D8`, borderRadius: 4, padding: '10 14', marginBottom: 20 },
    partyLabel: { fontSize: 8, color: '#909090', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
    partyName:  { fontFamily: PDF_FONT.bold, fontSize: 11 },
    partyLine:  { fontSize: 9, color: '#666', lineHeight: 1.5, marginTop: 3 },
    partyTax:   { fontSize: 8.5, color: '#909090', marginTop: 4 },
    // Payment schedule
    schedRow:   { flexDirection: 'row', borderBottom: '1 solid #F2F0EA', paddingVertical: 7 },
    schedHdr:   { flexDirection: 'row', borderBottom: '1 solid #E5E1D8', paddingBottom: 5, marginBottom: 2 },
    th:         { fontSize: 8, fontFamily: PDF_FONT.bold, color: '#909090', textTransform: 'uppercase', letterSpacing: 0.5 },
    td:         { fontSize: 9.5, color: '#1A1A1A' },
    tdSub:      { fontSize: 8, color: '#909090', marginTop: 1 },
    mono:       { fontFamily: 'Courier', fontSize: 9.5 },
    // Sections
    section:    { marginBottom: 16 },
    secTitle:   { fontSize: 8, fontFamily: PDF_FONT.bold, color: '#909090', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6, borderBottom: `1 solid #E5E1D8`, paddingBottom: 3 },
    body:       { fontSize: 10, color: '#333', lineHeight: 1.65 },
    // Signature
    sigBlock:   { flexDirection: 'row', gap: 40, marginTop: 28, paddingTop: 16, borderTop: `1 solid #E5E1D8` },
    sigCol:     { flex: 1 },
    sigLabel:   { fontSize: 8, color: '#909090', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 },
    sigLine:    { borderBottom: `1 solid #1A1A1A`, height: 28, marginBottom: 4 },
    sigImg:     { height: 32, maxWidth: 160, marginBottom: 4, objectFit: 'contain' },
    sigName:    { fontFamily: PDF_FONT.bold, fontSize: 10 },
    sigDate:    { fontSize: 9, color: '#909090' },
    // Watermark
    watermark:  { position: 'absolute', top: '45%', left: '20%', fontSize: 64, color: 'rgba(0,0,0,0.04)', transform: 'rotate(-30deg)' },
    // Footer
    footer:     { flexDirection: 'row', justifyContent: 'space-between', marginTop: 28, paddingTop: 10, borderTop: `1 solid #E5E1D8`, fontSize: 8, color: '#B0B0B0' },
    footerLink: { color: '#B0B0B0', textDecoration: 'none' },
    // Doc chrome — running masthead (continuation pages only) + page numbers
    contMasthead: { flexDirection: 'row', justifyContent: 'space-between', fontSize: 7.5, color: '#B0B0B0', paddingBottom: 6, marginBottom: 14, borderBottom: '1 solid #F2F0EA' },
    pageNum:      { position: 'absolute', bottom: 18, right: 48, fontSize: 8, color: '#C0C0C0' },
    secNum:       { color: '#C0C0C0' },
  })

  // FIX (section-9 audit, 9-B2): a signed milestone SOW printed its
  // Payment Schedule TWICE — once as the `payment_schedule` section's own
  // table (which this filter never excluded), and again immediately below
  // as the `data.paymentSchedule` block sourced from payment_milestones.
  // Two separately-numbered "Payment Schedule" sections with different
  // formatting on the same signed contract. The two are the same
  // information at different lifecycle stages: the section table is what
  // the agency authored and the client agreed to; payment_milestones is
  // the tracked instantiation of it, which only exists after signing. Show
  // the milestone block when it exists (it carries real due dates and
  // statuses), and suppress the now-redundant section table in that case —
  // otherwise show the section table, so an unsigned SOW still presents
  // its schedule to the client.
  // Only when the agreement itself carries a schedule section. A 50/50 or lump-sum SOW keeps its
  // payment_schedule section hidden; the tracked milestone rows created at signing used to add a
  // "Payment Schedule" section anyway — one the client never reviewed — and shifted every later
  // section number in the signed copy.
  const scheduleSectionVisible = data.sections.find(sec => sec.id === 'payment_schedule')?.visible !== false
  const hasMilestoneBlock = !!(data.paymentSchedule && data.paymentSchedule.length > 0) && scheduleSectionVisible
  const sections = data.sections
    .filter(sec => sec.visible && !['parties','signature'].includes(sec.id))
    .filter(sec => !(hasMilestoneBlock && sec.id === 'payment_schedule'))
    .sort((a, b) => a.order - b.order)

  // The milestone block takes over the suppressed section's place in the
  // numbering rather than being appended after everything else, so the
  // schedule stays where the document's own ordering puts it.
  const scheduleOrder = data.sections.find(sec => sec.id === 'payment_schedule')?.order ?? Infinity
  const scheduleIndex = sections.filter(sec => sec.order < scheduleOrder).length
  // FIX (section-9 audit, 9-G7): this heading was the one section title
  // hardcoded in English rather than read off the stored (already
  // localized) section list.
  const paymentScheduleTitle =
    data.sections.find(sec => sec.id === 'payment_schedule')?.title || 'Payment Schedule'

  return (
    <Document>
      <Page size="A4" style={s.page}>
        {data.isWatermarked && <Text style={s.watermark}>DRAFT</Text>}

        {/* Running masthead — fixed, only renders on page 2+ so a
            multi-page SOW never loses its identity after the first page,
            without repeating the full header (logo + contract value)
            on every page. */}
        <Text
          style={s.contMasthead}
          fixed
          render={({ pageNumber }) =>
            pageNumber > 1
              ? `${data.agencyName} · Statement of Work${data.documentNumber ? ` · ${data.documentNumber}` : ''} · ${data.projectName}`
              : ''
          }
        />

        {/* Header */}
        <View style={s.header}>
          <View>
            <Text style={s.h1}>Statement of Work</Text>
            <Text style={s.meta}>{data.documentNumber ? `${data.documentNumber} · ` : ''}Version {data.version} · {data.projectName}</Text>
            {data.msaReference && <Text style={[s.meta, { marginTop: 2 }]}>{data.msaReference}</Text>}
            {data.signedAt && <Text style={[s.meta, { color: c, marginTop: 2 }]}>Signed {fmtDate(data.signedAt)}</Text>}
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            {logo
              ? <Image src={logo} style={s.logo} />
              : <Text style={s.agencyText}>{data.agencyName}</Text>}
            <Text style={s.value}>{data.currency} {fmtMoney(data.contractValue)}</Text>
            <Text style={s.valueLabel}>Contract value</Text>
          </View>
        </View>

        {/* Parties */}
        <View style={s.partiesBox}>
          <View style={{ flex: 1 }}>
            <Text style={s.partyLabel}>Agency (Service Provider)</Text>
            <Text style={s.partyName}>{data.agencyName}</Text>
            {formatAddress(data.agencyAddress).map((l, i) => <Text key={i} style={s.partyLine}>{l}</Text>)}
            {(data.agencyTaxId || data.agencyPhone || data.agencyWebsite) && (
              <Text style={s.partyTax}>
                {[data.agencyTaxId ? `Tax ID ${data.agencyTaxId}` : null, data.agencyPhone, data.agencyWebsite].filter(Boolean).join('  ·  ')}
              </Text>
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.partyLabel}>Client</Text>
            <Text style={s.partyName}>{data.clientCompany || data.clientName}</Text>
            {data.clientCompany && <Text style={s.partyLine}>{data.clientName}</Text>}
            {formatAddress(data.clientBillingAddress).map((l, i) => <Text key={i} style={s.partyLine}>{l}</Text>)}
            {data.clientVatNumber && <Text style={s.partyTax}>VAT {data.clientVatNumber}</Text>}
          </View>
        </View>

        {/* The Parties section's own text (the "entered into between…" preamble, or any special
            party terms the agency wrote). The boxed block above is generated from data; the
            authored prose used to be filtered out of the document entirely although the editor
            presents it as a required, editable section. */}
        {(() => {
          const partiesSec = data.sections.find(sec => sec.id === 'parties' && sec.visible)
          return partiesSec && hasRichText(partiesSec.content)
            ? <View style={{ marginBottom: 16 }}><RichText html={partiesSec.content} style={s.body} /></View>
            : null
        })()}

        {/* Sections — numbered in document order, same convention as a
            traditional firm-issued SOW (1. Project Overview, 2.
            Deliverables, …). Deliverables/Timeline/Roles render as
            tables; everything else renders as formatted rich text.

            FIX (section-9 audit, 9-B2): the Payment Schedule used to be
            appended after every section, hard-numbered `sections.length + 1`,
            WHILE the payment_schedule section's own table also rendered
            inside the loop — the same schedule printed twice on a signed
            contract, under two different numbers and two different
            layouts. The milestone block is now spliced in at the
            suppressed section's own position instead of tacked onto the
            end, so numbering and reading order agree. */}
        {sections.slice(0, hasMilestoneBlock ? scheduleIndex : sections.length).map((sec, i) => (
          <SowSection key={sec.id} sec={sec} num={i + 1} s={s} language={data.language} />
        ))}

        {/* Payment schedule — sourced from payment_milestones, which only
            exist once the SOW is signed. Before signing there is nothing
            here and the authored payment_schedule section table renders
            in the loop above instead, so the client always sees exactly
            one schedule at every stage. */}
        {hasMilestoneBlock && (
          <View style={s.section} wrap={false}>
            <Text style={s.secTitle}>
              <Text style={s.secNum}>{scheduleIndex + 1}. </Text>{paymentScheduleTitle}
            </Text>
            <View style={s.schedHdr}>
              <Text style={[s.th, { flex: 1 }]}>{milestoneBlockLabels(data.language).milestone}</Text>
              <Text style={[s.th, { width: 90, textAlign: 'right' }]}>{milestoneBlockLabels(data.language).amount}</Text>
              <Text style={[s.th, { width: 90, textAlign: 'right' }]}>{milestoneBlockLabels(data.language).due}</Text>
            </View>
            {data.paymentSchedule!.map((m, i) => (
              <View key={i} style={s.schedRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.td}>{m.title}</Text>
                  <Text style={s.tdSub}>{m.trigger}{m.percentage ? ` · ${m.percentage}%` : ''}</Text>
                </View>
                <Text style={[s.td, s.mono, { width: 90, textAlign: 'right' }]}>{data.currency} {fmtMoney(m.amount)}</Text>
                <Text style={[s.td, { width: 90, textAlign: 'right', color: '#909090', fontSize: 9 }]}>
                  {m.dueDate ? fmtDate(m.dueDate) : '—'}
                </Text>
              </View>
            ))}
          </View>
        )}

        {hasMilestoneBlock && sections.slice(scheduleIndex).map((sec, i) => (
          <SowSection key={sec.id} sec={sec} num={scheduleIndex + i + 2} s={s} language={data.language} />
        ))}

        {/* Signature block. FIX (doc-quality audit round 3): had no
            wrap={false}, so when this landed near a page boundary
            react-pdf would split it mid-block — agency/client labels on
            one page, the actual signature lines stranded alone on the
            next, followed by a mostly-blank page. The one section of a
            signed document that has to render as a single visual unit
            was the one section not guarded against that. */}
        {/* The agreement clause ("By signing below, both parties agree…") the agency can edit under
            the Signature section — previously never printed, so the signed document contained no
            express statement of assent. */}
        {(() => {
          const sigSec = data.sections.find(sec => sec.id === 'signature' && sec.visible)
          return sigSec && hasRichText(sigSec.content)
            ? <View style={{ marginTop: 20 }} wrap={false}><RichText html={sigSec.content} style={s.body} /></View>
            : null
        })()}

        <View style={s.sigBlock} wrap={false}>
          <View style={s.sigCol}>
            <Text style={s.sigLabel}>Agency — {data.agencyName}</Text>
            {data.agencySignatureData ? (
              <Image src={data.agencySignatureData} style={s.sigImg} />
            ) : (
              <View style={s.sigLine} />
            )}
            <Text style={s.sigName}>{data.agencyName}</Text>
          </View>
          <View style={s.sigCol}>
            <Text style={s.sigLabel}>Client — {data.clientName}</Text>
            {data.clientSignatureData ? (
              <Image src={data.clientSignatureData} style={s.sigImg} />
            ) : (
              <View style={[s.sigLine, data.signedBy ? { borderBottom: `2 solid ${c}` } : {}]} />
            )}
            {data.signedBy
              ? <>
                  <Text style={[s.sigName, { color: c }]}>{data.signedBy}</Text>
                  {data.signedAt && <Text style={s.sigDate}>{fmtDate(data.signedAt)}</Text>}
                </>
              : <Text style={[s.sigName, { color: '#B0B0B0' }]}>Not yet signed</Text>}
          </View>
        </View>

        {/* Footer */}
        <View style={s.footer}>
          <Text>Scope governance by <Link src={SCOPEGOV_URL} style={s.footerLink}>ScopeGov</Link></Text>
          <Text>Generated {fmtDate(new Date().toISOString())}</Text>
        </View>

        {/* Page numbers — fixed, only shown once the document actually
            runs past one page, so a short single-page SOW doesn't get a
            pointless "Page 1 of 1". */}
        <Text
          style={s.pageNum}
          fixed
          render={({ pageNumber, totalPages }) => (totalPages > 1 ? `Page ${pageNumber} of ${totalPages}` : '')}
        />
      </Page>
    </Document>
  )
}

// ── CO PDF ───────────────────────────────────────────────────

// Firm-issued change orders always show a status badge, even (especially)
// before acceptance — Meridian's sample shows "PENDING APPROVAL" front
// and center. `accepted`/`declined` reuse the signature block's own
// visual treatment below, so they're intentionally muted here to avoid
// redundant emphasis; the states that most need a loud badge are the
// in-limbo ones where nothing else on the page communicates status.
const CO_STATUS_LABEL: Record<string, string> = {
  draft:                     'Draft',
  awaiting_response:         'Pending Approval',
  awaiting_countersignature: 'Awaiting Countersignature',
  accepted:                  'Accepted',
  declined:                  'Declined',
  countered:                 'Countered',
  closed:                    'Closed',
  stalled:                   'Stalled',
  withdrawn:                 'Withdrawn',
  exception_granted:         'Exception Granted',
}
const CO_STATUS_LOUD = new Set(['awaiting_response', 'awaiting_countersignature', 'countered', 'stalled'])

function CoDocument({ data, logo }: { data: CoPdfData; logo: string | null }) {
  const c = data.brandColour || '#1A5C3A'
  const statusLabel = data.status ? (CO_STATUS_LABEL[data.status] || data.status) : null
  const statusLoud  = data.status ? CO_STATUS_LOUD.has(data.status) : false

  const s = StyleSheet.create({
    page:      { fontFamily: PDF_FONT.sans, fontSize: 10, color: '#1A1A1A', padding: '40 48' },
    header:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: `2 solid ${c}`, paddingBottom: 14, marginBottom: 20 },
    h1:        { fontFamily: PDF_FONT.bold, fontSize: 16, color: c, marginBottom: 3 },
    meta:      { fontSize: 8.5, color: '#909090' },
    logo:      { maxHeight: 38, maxWidth: 90, objectFit: 'contain' },
    agencyText:{ fontFamily: PDF_FONT.bold, fontSize: 11, color: c },
    noteBox:   { backgroundColor: '#F9F8F5', border: `1 solid #E5E1D8`, borderRadius: 4, padding: '10 14', marginBottom: 18, fontSize: 10, color: '#333', lineHeight: 1.6 },
    partiesBox:{ flexDirection: 'row', gap: 32, backgroundColor: '#F9F8F5', border: `1 solid #E5E1D8`, borderRadius: 4, padding: '10 14', marginBottom: 18 },
    partyLabel:{ fontSize: 8, color: '#909090', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
    partyName: { fontFamily: PDF_FONT.bold, fontSize: 11 },
    partyLine: { fontSize: 9, color: '#666', lineHeight: 1.5, marginTop: 3 },
    partyTax:  { fontSize: 8.5, color: '#909090', marginTop: 4 },
    // FIX (re-audit): CoDocument never had a draft watermark at all,
    // unlike SowDocument. A draft CO (downloadable from CoEditor before
    // it's ever sent) was visually identical to a final, client-signed one.
    watermark: { position: 'absolute', top: '45%', left: '20%', fontSize: 64, color: 'rgba(0,0,0,0.04)', transform: 'rotate(-30deg)' },
    // Table
    tableHdr:  { flexDirection: 'row', borderBottom: `1 solid #E5E1D8`, paddingBottom: 5, marginBottom: 2 },
    th:        { fontSize: 8, fontFamily: PDF_FONT.bold, color: '#909090', textTransform: 'uppercase', letterSpacing: 0.5 },
    row:       { flexDirection: 'row', borderBottom: `1 solid #F2F0EA`, paddingVertical: 8 },
    td:        { fontSize: 10, color: '#1A1A1A' },
    mono:      { fontFamily: 'Courier', fontSize: 9.5 },
    // Totals
    totals:    { marginTop: 10, paddingTop: 10, borderTop: `1 solid #E5E1D8` },
    totalRow:  { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2, fontSize: 10 },
    grandRow:  { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 6, marginTop: 4, borderTop: `1 solid #1A1A1A`, fontSize: 13, fontFamily: PDF_FONT.bold },
    // Sig
    sigBlock:  { flexDirection: 'row', gap: 40, marginTop: 28, paddingTop: 16, borderTop: `1 solid #E5E1D8` },
    sigCol:    { flex: 1 },
    sigLabel:  { fontSize: 8, color: '#909090', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 },
    sigLine:   { borderBottom: `1 solid #1A1A1A`, height: 26, marginBottom: 4 },
    sigImg:    { height: 30, maxWidth: 150, marginBottom: 4, objectFit: 'contain' },
    sigName:   { fontFamily: PDF_FONT.bold, fontSize: 10 },
    footer:    { flexDirection: 'row', justifyContent: 'space-between', marginTop: 24, paddingTop: 10, borderTop: `1 solid #E5E1D8`, fontSize: 8, color: '#B0B0B0' },
    footerLink:{ color: '#B0B0B0', textDecoration: 'none' },
    // Status badge + section numbering + impact block (doc-quality audit round 2)
    statusBadge:  { fontSize: 8.5, fontFamily: PDF_FONT.bold, textTransform: 'uppercase', letterSpacing: 0.6, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 3, marginTop: 6, alignSelf: 'flex-end' },
    secTitle:  { fontSize: 8, fontFamily: PDF_FONT.bold, color: '#909090', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6, borderBottom: '1 solid #E5E1D8', paddingBottom: 3 },
    secNum:    { color: '#C0C0C0' },
    section:   { marginBottom: 18 },
    impactBox: { border: '1 solid #E5E1D8', borderRadius: 4, marginTop: 12, padding: '10 14' },
    impactRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3, fontSize: 10 },
    impactGrand: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 6, marginTop: 4, borderTop: '1 solid #1A1A1A', fontSize: 12, fontFamily: PDF_FONT.bold },
    pageNum:   { position: 'absolute', bottom: 18, right: 48, fontSize: 8, color: '#C0C0C0' },
  })

  // FIX (section-10 audit, 10-B3): a tax-inclusive CO printed no tax
  // amount at all — just "Subtotal X / Tax included (16%) / Total X",
  // where Subtotal and Total were the same number, on a document that
  // prints the client's VAT registration number. `subtotal` is stored net
  // of tax on both paths now (see lib/documents/co-totals.ts), so the tax
  // component is simply total − subtotal and can be stated either way.
  const tax = data.taxRate > 0
    ? Math.round((data.total - data.subtotal + Number.EPSILON) * 100) / 100
    : 0

  // Section numbering — computed from which optional sections are
  // actually present, same convention as the SOW's "1. / 2. / 3.".
  let secN = 0
  const noteSecNum   = data.note ? ++secN : null
  const itemsSecNum  = ++secN
  // FIX (doc-quality audit round 3): this block used to gate purely on
  // contractValueBefore (renders only the Value row). Now gates on any
  // of Scope/Timeline/Value being present, since a CO can carry a
  // timeline or scope impact with no financial component at all.
  const hasScopeImpact    = !!data.scopeImpactNote
  const hasTimelineImpact = data.timelineImpactDays != null && data.timelineImpactDays !== 0
  const hasValueImpact    = data.contractValueBefore != null
  const impactSecNum = (hasScopeImpact || hasTimelineImpact || hasValueImpact) ? ++secN : null
  const revisedValue = data.revisedContractValue != null
    ? data.revisedContractValue
    : data.contractValueBefore != null ? data.contractValueBefore + data.total : null
  const isRenewalDoc = !!data.isRetainerRenewal

  return (
    <Document>
      <Page size="A4" style={s.page}>
        {data.isWatermarked && <Text style={s.watermark}>DRAFT</Text>}
        {/* Header */}
        <View style={s.header}>
          <View>
            <Text style={s.h1}>Change Order</Text>
            <Text style={s.meta}>{data.documentNumber ? `${data.documentNumber} · ` : ''}{data.coTitle}</Text>
            <Text style={s.meta}>{data.projectName}</Text>
            {data.sowNumber && <Text style={[s.meta, { marginTop: 2 }]}>Amends SOW No. {data.sowNumber}</Text>}
            {data.acceptedAt && <Text style={[s.meta, { color: c, marginTop: 2 }]}>Accepted {fmtDate(data.acceptedAt)}</Text>}
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            {logo
              ? <Image src={logo} style={s.logo} />
              : <Text style={s.agencyText}>{data.agencyName}</Text>}
            {statusLabel && (
              <Text style={[s.statusBadge, statusLoud
                ? { backgroundColor: '#FDF3E7', color: '#B8611A' }
                : { backgroundColor: '#F2F0EA', color: '#909090' }]}>
                {statusLabel}
              </Text>
            )}
          </View>
        </View>

        {/* Parties */}
        <View style={s.partiesBox}>
          <View style={{ flex: 1 }}>
            <Text style={s.partyLabel}>Agency (Service Provider)</Text>
            <Text style={s.partyName}>{data.agencyName}</Text>
            {formatAddress(data.agencyAddress).map((l, i) => <Text key={i} style={s.partyLine}>{l}</Text>)}
            {(data.agencyTaxId || data.agencyPhone || data.agencyWebsite) && (
              <Text style={s.partyTax}>
                {[data.agencyTaxId ? `Tax ID ${data.agencyTaxId}` : null, data.agencyPhone, data.agencyWebsite].filter(Boolean).join('  ·  ')}
              </Text>
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.partyLabel}>Client</Text>
            <Text style={s.partyName}>{data.clientCompany || data.clientName}</Text>
            {data.clientCompany && <Text style={s.partyLine}>{data.clientName}</Text>}
            {formatAddress(data.clientBillingAddress).map((l, i) => <Text key={i} style={s.partyLine}>{l}</Text>)}
            {data.clientVatNumber && <Text style={s.partyTax}>VAT {data.clientVatNumber}</Text>}
          </View>
        </View>

        {/* Reason for change */}
        {data.note && (
          <View style={s.section}>
            <Text style={s.secTitle}><Text style={s.secNum}>{noteSecNum}. </Text>Reason for Change</Text>
            <View style={s.noteBox}><RichText html={data.note} style={{ fontSize: 10, color: '#1A1A1A', lineHeight: 1.5 }} /></View>
          </View>
        )}

        {/* Line items table */}
        <View style={s.section}>
          <Text style={s.secTitle}><Text style={s.secNum}>{itemsSecNum}. </Text>Description of Change</Text>
          <View style={s.tableHdr}>
            <Text style={[s.th, { flex: 1 }]}>Description</Text>
            <Text style={[s.th, { width: 40, textAlign: 'center' }]}>Qty</Text>
            <Text style={[s.th, { width: 80, textAlign: 'right' }]}>Rate</Text>
            <Text style={[s.th, { width: 80, textAlign: 'right' }]}>Total</Text>
          </View>
          {data.lineItems.map((item, i) => (
            <View key={i} style={s.row}>
              <Text style={[s.td, { flex: 1 }]}>{item.description}</Text>
              <Text style={[s.td, s.mono, { width: 40, textAlign: 'center' }]}>{item.quantity}</Text>
              <Text style={[s.td, s.mono, { width: 80, textAlign: 'right' }]}>{data.currency} {fmtMoney(item.rate)}</Text>
              <Text style={[s.td, s.mono, { width: 80, textAlign: 'right' }]}>{data.currency} {fmtMoney(item.total)}</Text>
            </View>
          ))}

          {/* Totals */}
          <View style={s.totals}>
            <View style={s.totalRow}>
              <Text>Subtotal</Text>
              <Text style={s.mono}>{data.currency} {fmtMoney(data.subtotal)}</Text>
            </View>
            {tax > 0 && (
              <View style={s.totalRow}>
                <Text>Tax ({data.taxRate}%){data.taxInclusive ? ' — included' : ''}</Text>
                <Text style={s.mono}>{data.currency} {fmtMoney(tax)}</Text>
              </View>
            )}
            <View style={s.grandRow}>
              <Text>Total</Text>
              <Text style={[s.mono, { color: c }]}>{data.currency} {fmtMoney(data.total)}</Text>
            </View>
          </View>
        </View>

        {/* Impact Analysis — Meridian's equivalent, now genuinely three
            areas (Scope / Timeline / Value) instead of value-only.
            FIX (doc-quality audit round 3, migration 018): previously
            gated and titled around contract value alone, so a CO that
            shifted a delivery date or added scope with no fee attached
            had nowhere structured to say so — only the free-text "Reason
            for Change" note, indistinguishable from general prose. Each
            row is independent and optional; a CO can carry any subset. */}
        {impactSecNum && (
          <View style={s.section}>
            <Text style={s.secTitle}><Text style={s.secNum}>{impactSecNum}. </Text>Impact Analysis</Text>
            <View style={s.impactBox}>
              {hasScopeImpact && (
                <View style={[s.impactRow, { flexDirection: 'column', alignItems: 'flex-start', paddingBottom: 8 }]}>
                  <Text style={{ color: '#909090', marginBottom: 3 }}>Scope</Text>
                  <Text style={{ fontSize: 10, color: '#1A1A1A', lineHeight: 1.5 }}>{data.scopeImpactNote}</Text>
                </View>
              )}
              {hasTimelineImpact && (
                <View style={s.impactRow}>
                  <Text style={{ color: '#909090' }}>Timeline</Text>
                  <Text style={s.mono}>{data.timelineImpactDays! > 0 ? '+' : ''}{data.timelineImpactDays} day{Math.abs(data.timelineImpactDays!) === 1 ? '' : 's'}</Text>
                </View>
              )}
              {hasValueImpact && revisedValue != null && (
                <View style={(hasScopeImpact || hasTimelineImpact) ? { marginTop: 6, paddingTop: 6, borderTop: '1 solid #F2F0EA' } : undefined}>
                  <View style={s.impactRow}>
                    <Text style={{ color: '#909090' }}>{isRenewalDoc ? 'Current Monthly Rate' : 'Original Contract Value'}</Text>
                    <Text style={s.mono}>{data.currency} {fmtMoney(data.contractValueBefore!)}</Text>
                  </View>
                  <View style={s.impactRow}>
                    <Text style={{ color: '#909090' }}>{isRenewalDoc ? 'Rate Change' : 'This Change Order'}</Text>
                    {/* FIX (section-10 audit, 10-B4): the '+' was
                        hardcoded, so a CO with a negative total printed
                        "+USD -5,000". Negative line items are refused at
                        the API now (see lib/documents/co-totals.ts), but
                        rescale-line-items can still append a negative
                        "Negotiated discount" line, so the sign has to be
                        derived rather than assumed. */}
                    <Text style={s.mono}>
                      {(() => {
                        const delta = isRenewalDoc ? revisedValue - data.contractValueBefore! : data.total
                        return `${delta < 0 ? '−' : '+'}${data.currency} ${fmtMoney(Math.abs(delta))}`
                      })()}
                    </Text>
                  </View>
                  <View style={s.impactGrand}>
                    <Text>{isRenewalDoc ? 'New Monthly Rate' : 'Revised Contract Value'}</Text>
                    <Text style={{ fontFamily: 'Courier-Bold', color: c }}>{data.currency} {fmtMoney(revisedValue)}</Text>
                  </View>
                </View>
              )}
            </View>
          </View>
        )}

        {/* Signature block. FIX (doc-quality audit round 3): same
            missing wrap={false} as the SOW's — could split mid-block
            across a page boundary, stranding the signature lines alone
            on a near-empty trailing page. */}
        <View style={s.sigBlock} wrap={false}>
          <View style={s.sigCol}>
            <Text style={s.sigLabel}>Agency — {data.agencyName}</Text>
            {data.agencySignatureData ? (
              <Image src={data.agencySignatureData} style={s.sigImg} />
            ) : (
              <View style={s.sigLine} />
            )}
            <Text style={s.sigName}>{data.agencyName}</Text>
          </View>
          <View style={s.sigCol}>
            <Text style={s.sigLabel}>Client — {data.clientName}</Text>
            {data.clientSignatureData ? (
              <Image src={data.clientSignatureData} style={s.sigImg} />
            ) : (
              <View style={[s.sigLine, data.acceptedBy ? { borderBottom: `2 solid ${c}` } : {}]} />
            )}
            {data.acceptedBy
              ? <>
                  <Text style={[s.sigName, { color: c }]}>{data.acceptedBy}</Text>
                  {data.acceptedAt && <Text style={{ fontSize: 9, color: '#909090' }}>{fmtDate(data.acceptedAt)}</Text>}
                </>
              : <Text style={[s.sigName, { color: '#B0B0B0' }]}>Pending</Text>}
          </View>
        </View>

        <View style={s.footer}>
          <Text>Scope governance by <Link src={SCOPEGOV_URL} style={s.footerLink}>ScopeGov</Link></Text>
          <Text>Generated {fmtDate(new Date().toISOString())}</Text>
        </View>

        <Text
          style={s.pageNum}
          fixed
          render={({ pageNumber, totalPages }) => (totalPages > 1 ? `Page ${pageNumber} of ${totalPages}` : '')}
        />
      </Page>
    </Document>
  )
}

// ── INVOICE PDF ──────────────────────────────────────────────

const INVOICE_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', sent: 'Awaiting payment', partially_paid: 'Partially paid',
  paid: 'Paid', overdue: 'Overdue', void: 'Void',
}
const INVOICE_METHOD_LABEL: Record<string, string> = {
  bank_transfer: 'Bank transfer', stripe: 'Stripe', check: 'Check', cash: 'Cash', other: 'Other',
}

function InvoiceDocument({ data, logo }: { data: InvoicePdfData; logo: string | null }) {
  const c = data.brandColour || '#1A5C3A'
  // FIX (section-12 audit, pass 2): fmtInv() (shared with the SOW/CO documents)
  // prints whole amounts with no decimals and everything else with two, so an
  // invoice's own column could read "1,160" above "386.66" — and every figure was
  // rounded independently, so subtotal + tax could disagree with the total by a
  // cent. Invoices print the currency's own minor units on every line (2 for USD/EUR/KES,
  // 0 for JPY, 3 for KWD), from figures rounded once.
  const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100
  const digits = (() => {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: data.currency }).resolvedOptions().maximumFractionDigits ?? 2 }
    catch { return 2 }
  })()
  const fmtInv = (n: number) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  const invAmount = r2(data.amount)
  const balanceDue = Math.max(0, r2(invAmount - r2(data.amountPaid)))
  // Tax breakdown, mirroring CoDocument. The tax amount is derived as total −
  // subtotal, so the three printed rows always foot — and for a tax-INCLUSIVE
  // invoice it is finally stated (the label used to print "Tax included (16%)" with
  // no figure, on a document that also prints the client's VAT number).
  const invSubtotal = r2(data.subtotal ?? data.amount)
  const hasTax = (data.taxRate || 0) > 0
  const invTaxAmount = hasTax ? r2(invAmount - invSubtotal) : 0
  const invTax = hasTax && !data.taxInclusive ? invTaxAmount : 0

  const s = StyleSheet.create({
    page:      { fontFamily: PDF_FONT.sans, fontSize: 10, color: '#1A1A1A', padding: '40 48' },
    header:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: `2 solid ${c}`, paddingBottom: 14, marginBottom: 20 },
    h1:        { fontFamily: PDF_FONT.bold, fontSize: 18, color: c, marginBottom: 3 },
    meta:      { fontSize: 8.5, color: '#909090' },
    logo:      { maxHeight: 42, maxWidth: 100, objectFit: 'contain' },
    agencyText:{ fontFamily: PDF_FONT.bold, fontSize: 11, color: c },
    statusPill:{ fontSize: 8, fontFamily: PDF_FONT.bold, color: c, textTransform: 'uppercase', letterSpacing: 0.5, textAlign: 'right', marginBottom: 4 },
    partiesBox:{ flexDirection: 'row', gap: 32, backgroundColor: '#F9F8F5', border: '1 solid #E5E1D8', borderRadius: 4, padding: '10 14', marginBottom: 20 },
    partyLabel:{ fontSize: 8, color: '#909090', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
    partyName: { fontFamily: PDF_FONT.bold, fontSize: 11 },
    partyLine: { fontSize: 9, color: '#666', lineHeight: 1.5, marginTop: 3 },
    partyTax:  { fontSize: 8.5, color: '#909090', marginTop: 4 },
    lineBox:   { border: '1 solid #E5E1D8', borderRadius: 4, marginBottom: 16 },
    lineRow:   { flexDirection: 'row', justifyContent: 'space-between', padding: '12 14', borderBottom: '1 solid #F2F0EA' },
    lineDesc:  { fontSize: 11, color: '#1A1A1A' },
    lineSub:   { fontSize: 8.5, color: '#909090', marginTop: 2 },
    lineAmt:   { fontSize: 11, fontFamily: 'Courier-Bold' },
    totals:    { marginTop: 4 },
    totalRow:  { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3, fontSize: 10 },
    grandRow:  { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 8, marginTop: 6, borderTop: '1 solid #1A1A1A', fontSize: 14, fontFamily: PDF_FONT.bold },
    section:   { marginTop: 20 },
    secTitle:  { fontSize: 8, fontFamily: PDF_FONT.bold, color: '#909090', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6, borderBottom: '1 solid #E5E1D8', paddingBottom: 3 },
    body:      { fontSize: 10, color: '#333', lineHeight: 1.6 },
    payRow:    { flexDirection: 'row', justifyContent: 'space-between', fontSize: 9.5, color: '#555', paddingVertical: 3, borderBottom: '1 solid #F2F0EA' },
    cpRow:     { flexDirection: 'row', justifyContent: 'space-between', fontSize: 9.5, color: '#555', paddingVertical: 3 },
    footer:    { marginTop: 28, paddingTop: 10, borderTop: '1 solid #E5E1D8', fontSize: 8, color: '#B0B0B0' },
    footerRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
    footerLink:{ color: '#B0B0B0', textDecoration: 'none' },
    pageNum:   { position: 'absolute', bottom: 18, right: 48, fontSize: 8, color: '#C0C0C0' },
    // Multi-line itemization (migration 017)
    itemsBox:  { border: '1 solid #E5E1D8', borderRadius: 4, marginBottom: 16, overflow: 'hidden' },
    itemsHdr:  { flexDirection: 'row', backgroundColor: '#F9F8F5', borderBottom: '1 solid #E5E1D8', paddingVertical: 6, paddingHorizontal: 12 },
    itemsTh:   { fontSize: 8, fontFamily: PDF_FONT.bold, color: '#909090', textTransform: 'uppercase', letterSpacing: 0.5 },
    itemsRow:  { flexDirection: 'row', paddingVertical: 8, paddingHorizontal: 12, borderBottom: '1 solid #F2F0EA' },
    itemsTd:   { fontSize: 10, color: '#1A1A1A' },
  })

  return (
    <Document>
      <Page size="A4" style={s.page}>
        <View style={s.header}>
          <View>
            <Text style={s.h1}>Invoice</Text>
            <Text style={s.meta}>{data.invoiceNumber ? `${data.invoiceNumber} · ` : ''}{data.projectName}</Text>
            {data.sentAt && <Text style={[s.meta, { marginTop: 2 }]}>Issued {fmtDate(data.sentAt)}{data.dueDate ? ` · Due ${fmtDate(data.dueDate)}` : ''}</Text>}
            {data.poNumber && <Text style={[s.meta, { marginTop: 2 }]}>PO {data.poNumber}</Text>}
            {(data.sowNumber || data.coNumber) && (
              <Text style={[s.meta, { marginTop: 2 }]}>
                {data.sowNumber ? `For services under SOW No. ${data.sowNumber}` : ''}
                {data.sowNumber && data.coNumber ? ', ' : ''}
                {data.coNumber ? `as amended by Change Order No. ${data.coNumber}` : ''}
              </Text>
            )}
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            {logo ? <Image src={logo} style={s.logo} /> : <Text style={s.agencyText}>{data.agencyName}</Text>}
            <Text style={[s.statusPill, { marginTop: 8 }]}>{INVOICE_STATUS_LABEL[data.status] || data.status}</Text>
          </View>
        </View>

        <View style={s.partiesBox}>
          <View style={{ flex: 1 }}>
            <Text style={s.partyLabel}>From</Text>
            <Text style={s.partyName}>{data.agencyName}</Text>
            {formatAddress(data.agencyAddress).map((l, i) => <Text key={i} style={s.partyLine}>{l}</Text>)}
            {(data.agencyTaxId || data.agencyPhone || data.agencyWebsite) && (
              <Text style={s.partyTax}>
                {[data.agencyTaxId ? `Tax ID ${data.agencyTaxId}` : null, data.agencyPhone, data.agencyWebsite].filter(Boolean).join('  ·  ')}
              </Text>
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.partyLabel}>Billed to</Text>
            <Text style={s.partyName}>{data.clientCompany || data.clientName}</Text>
            {data.clientCompany && <Text style={s.partyLine}>{data.clientName}</Text>}
            {formatAddress(data.clientBillingAddress).map((l, i) => <Text key={i} style={s.partyLine}>{l}</Text>)}
            {data.clientVatNumber && <Text style={s.partyTax}>VAT {data.clientVatNumber}</Text>}
          </View>
        </View>

        {data.lineItems && data.lineItems.length > 0 ? (
          <View style={s.itemsBox}>
            <View style={s.itemsHdr}>
              <Text style={[s.itemsTh, { flex: 1 }]}>Description</Text>
              <Text style={[s.itemsTh, { width: 40, textAlign: 'center' }]}>Qty</Text>
              <Text style={[s.itemsTh, { width: 90, textAlign: 'right' }]}>Rate</Text>
              <Text style={[s.itemsTh, { width: 90, textAlign: 'right' }]}>Amount</Text>
            </View>
            {data.lineItems.map((item, i) => (
              <View key={i} style={[s.itemsRow, i === data.lineItems!.length - 1 ? { borderBottom: 'none' } : {}]}>
                <Text style={[s.itemsTd, { flex: 1 }]}>{item.description}</Text>
                <Text style={[s.itemsTd, { width: 40, textAlign: 'center', fontFamily: 'Courier' }]}>{item.quantity}</Text>
                <Text style={[s.itemsTd, { width: 90, textAlign: 'right', fontFamily: 'Courier' }]}>{item.rate ? `${data.currency} ${fmtInv(item.rate)}` : '—'}</Text>
                <Text style={[s.itemsTd, { width: 90, textAlign: 'right', fontFamily: 'Courier-Bold' }]}>{data.currency} {fmtInv(item.total)}</Text>
              </View>
            ))}
          </View>
        ) : (
          <View style={s.lineBox}>
            <View style={s.lineRow}>
              <View>
                <Text style={s.lineDesc}>{data.title}</Text>
                {data.milestoneTrigger && <Text style={s.lineSub}>{data.milestoneTrigger}</Text>}
              </View>
              <Text style={s.lineAmt}>{data.currency} {fmtInv(invAmount)}</Text>
            </View>
          </View>
        )}

        <View style={s.totals}>
          <View style={s.totalRow}>
            <Text style={{ color: '#909090' }}>{invTax > 0 || data.taxInclusive ? 'Subtotal' : 'Amount due'}</Text>
            <Text style={{ fontFamily: 'Courier' }}>{data.currency} {fmtInv(invSubtotal)}</Text>
          </View>
          {invTax > 0 && (
            <View style={s.totalRow}>
              <Text style={{ color: '#909090' }}>Tax ({data.taxRate}%)</Text>
              <Text style={{ fontFamily: 'Courier' }}>{data.currency} {fmtInv(invTax)}</Text>
            </View>
          )}
          {data.taxInclusive && hasTax && (
            <View style={s.totalRow}>
              <Text style={{ color: '#909090' }}>Tax included ({data.taxRate}%)</Text>
              <Text style={{ fontFamily: 'Courier' }}>{data.currency} {fmtInv(invTaxAmount)}</Text>
            </View>
          )}
          {(invTax > 0 || data.taxInclusive) && (
            <View style={s.totalRow}>
              <Text style={{ color: '#909090' }}>Amount due</Text>
              <Text style={{ fontFamily: 'Courier' }}>{data.currency} {fmtInv(invAmount)}</Text>
            </View>
          )}
          {data.amountPaid > 0 && (
            <View style={s.totalRow}>
              <Text style={{ color: '#1A5C3A' }}>Paid to date</Text>
              <Text style={{ fontFamily: 'Courier', color: '#1A5C3A' }}>-{data.currency} {fmtInv(data.amountPaid)}</Text>
            </View>
          )}
          <View style={s.grandRow}>
            <Text>{balanceDue > 0 ? 'Balance due' : 'Paid in full'}</Text>
            <Text style={{ color: c }}>{data.currency} {fmtInv(balanceDue)}</Text>
          </View>
        </View>

        {/* FIX (doc-quality audit round 3): anti-double-billing line,
            Meridian's sample equivalent ("No amounts from that Change
            Order's fixed-fee items are included in this invoice."). Only
            claims what's always structurally true — this invoice bills
            exactly what's itemized above, nothing else — since the data
            model doesn't currently track cross-invoice overlap precisely
            enough to name a specific excluded CO/milestone by number
            without risking a false claim. Shown whenever there's a
            SOW/CO cross-reference for a reader to potentially confuse
            this invoice's scope with. */}
        {(data.sowNumber || data.coNumber) && (
          <Text style={{ fontSize: 8.5, color: '#909090', marginTop: 8, lineHeight: 1.5 }}>
            This invoice reflects only the item{(data.lineItems?.length || 0) > 1 ? 's' : ''} itemized above — no other milestone, SOW, or change order amounts are included unless explicitly listed.
          </Text>
        )}

        {data.paymentInstructions && (
          <View style={s.section}>
            <Text style={s.secTitle}>Payment instructions</Text>
            <RichText html={data.paymentInstructions} style={s.body} />
          </View>
        )}

        {data.payments.length > 0 && (
          <View style={s.section}>
            <Text style={s.secTitle}>Payments received</Text>
            {data.payments.map((p, i) => (
              <View key={i} style={s.payRow}>
                <Text>{fmtDate(p.paidAt)} · {INVOICE_METHOD_LABEL[p.method] || p.method}{p.referenceNote ? ` · ${p.referenceNote}` : ''}</Text>
                <Text style={{ fontFamily: 'Courier' }}>{data.currency} {fmtInv(p.amount)}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Contract position — sourced from contract_reconciliation_snapshots,
            already computed nightly for the reporting dashboard but never
            shown to the client on the document itself before now. Gives an
            AP reviewer the running picture without a separate report. */}
        {data.contractPosition && (
          <View style={s.section}>
            <Text style={s.secTitle}>Contract position</Text>
            <View style={s.cpRow}>
              <Text>Contracted value</Text>
              <Text style={{ fontFamily: 'Courier' }}>{data.currency} {fmtInv(data.contractPosition.contractedValue)}</Text>
            </View>
            <View style={s.cpRow}>
              <Text>Invoiced to date (incl. this invoice)</Text>
              <Text style={{ fontFamily: 'Courier' }}>{data.currency} {fmtInv(data.contractPosition.invoicedToDate)}</Text>
            </View>
            <View style={s.cpRow}>
              <Text>Paid to date</Text>
              <Text style={{ fontFamily: 'Courier' }}>{data.currency} {fmtInv(data.contractPosition.paidToDate)}</Text>
            </View>
            <View style={[s.cpRow, { borderTop: '1 solid #F2F0EA', paddingTop: 6, marginTop: 2 }]}>
              <Text style={{ color: '#1A1A1A' }}>Remaining contract value</Text>
              <Text style={{ fontFamily: 'Courier-Bold', color: '#1A1A1A' }}>
                {data.currency} {fmtInv(Math.max(0, data.contractPosition.contractedValue - data.contractPosition.invoicedToDate))}
              </Text>
            </View>
          </View>
        )}

        <View style={s.footer}>
          <Text>This is a payment record, not a payment portal — pay per the instructions above.</Text>
          <View style={s.footerRow}>
            <Text>Scope governance by <Link src={SCOPEGOV_URL} style={s.footerLink}>ScopeGov</Link></Text>
            <Text>Generated {fmtDate(new Date().toISOString())}</Text>
          </View>
        </View>

        <Text
          style={s.pageNum}
          fixed
          render={({ pageNumber, totalPages }) => (totalPages > 1 ? `Page ${pageNumber} of ${totalPages}` : '')}
        />
      </Page>
    </Document>
  )
}

// ── Public exports (same interface as before) ─────────────────

export async function renderSowPdf(data: SowPdfData): Promise<Buffer> {
  const logo = await resolveLogoDataUri(data.agencyLogoUrl)
  return renderToBuffer(<SowDocument data={sanitizeForPdf(mapPdfSymbols(data))} logo={logo} />)
}

export async function renderCoPdf(data: CoPdfData): Promise<Buffer> {
  const logo = await resolveLogoDataUri(data.logoUrl)
  return renderToBuffer(<CoDocument data={sanitizeForPdf(mapPdfSymbols(data))} logo={logo} />)
}

export async function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  const logo = await resolveLogoDataUri(data.logoUrl)
  return renderToBuffer(<InvoiceDocument data={sanitizeForPdf(mapPdfSymbols(data))} logo={logo} />)
}

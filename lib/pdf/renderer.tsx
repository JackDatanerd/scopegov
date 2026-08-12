// lib/pdf/renderer.ts
// FIX 4B: Replaced Puppeteer/Chromium with @react-pdf/renderer.
// Pure Node.js — no browser, no timeout risk on Vercel Hobby.
// npm install @react-pdf/renderer

import React from 'react'
import {
  Document, Page, View, Text, Image,
  StyleSheet, renderToBuffer,
} from '@react-pdf/renderer'
import { safeFetch } from '@/lib/utils/safe-fetch'

export interface SowPdfData {
  agencyName:    string
  agencyLogoUrl: string | null
  brandColour:   string
  clientName:    string
  projectName:   string
  contractValue: number
  currency:      string
  sections:      Array<{ id: string; title: string; content: string; visible: boolean; order: number }>
  signedBy?:     string
  signedAt?:     string
  agencySignatureData?: string | null
  clientSignatureData?: string | null
  version:       number
  isWatermarked?: boolean
  documentNumber?: string | null
}

export interface CoPdfData {
  agencyName:   string
  logoUrl:      string | null
  brandColour:  string
  clientName:   string
  projectName:  string
  coTitle:      string
  note:         string | null
  lineItems:    Array<{ description: string; quantity: number; rate: number; total: number }>
  subtotal:     number
  taxRate:      number
  taxInclusive: boolean
  total:        number
  currency:     string
  acceptedBy?:  string
  acceptedAt?:  string
  agencySignatureData?: string | null
  clientSignatureData?: string | null
  isPartial?:   boolean
  partialNote?: string
  documentNumber?: string | null
}

export interface InvoicePdfData {
  agencyName:   string
  logoUrl:      string | null
  brandColour:  string
  clientName:   string
  clientCompany?: string | null
  projectName:  string
  invoiceNumber?: string | null
  title:        string
  amount:       number
  amountPaid:   number
  currency:     string
  status:       string
  dueDate?:     string | null
  sentAt?:      string | null
  paymentInstructions?: string | null
  payments:     Array<{ amount: number; paidAt: string; method: string; referenceNote?: string | null }>
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

function fmtMoney(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

// ── SOW PDF ──────────────────────────────────────────────────

function SowDocument({ data, logo }: { data: SowPdfData; logo: string | null }) {
  const c = data.brandColour || '#1A5C3A'

  const s = StyleSheet.create({
    page:       { fontFamily: 'Helvetica', fontSize: 10, color: '#1A1A1A', padding: '40 48' },
    // Header
    header:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: `2 solid ${c}`, paddingBottom: 14, marginBottom: 20 },
    h1:         { fontFamily: 'Helvetica-Bold', fontSize: 18, color: c, marginBottom: 3 },
    meta:       { fontSize: 8.5, color: '#909090' },
    logo:       { maxHeight: 42, maxWidth: 100, objectFit: 'contain' },
    agencyText: { fontFamily: 'Helvetica-Bold', fontSize: 11, color: c },
    valueLabel: { fontSize: 8, color: '#909090', textTransform: 'uppercase', letterSpacing: 0.5, textAlign: 'right' },
    value:      { fontSize: 16, color: c, textAlign: 'right', fontFamily: 'Helvetica-Bold' },
    // Parties
    partiesBox: { flexDirection: 'row', gap: 32, backgroundColor: '#F9F8F5', border: `1 solid #E5E1D8`, borderRadius: 4, padding: '10 14', marginBottom: 20 },
    partyLabel: { fontSize: 8, color: '#909090', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
    partyName:  { fontFamily: 'Helvetica-Bold', fontSize: 11 },
    // Sections
    section:    { marginBottom: 16 },
    secTitle:   { fontSize: 8, fontFamily: 'Helvetica-Bold', color: '#909090', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6, borderBottom: `1 solid #E5E1D8`, paddingBottom: 3 },
    body:       { fontSize: 10, color: '#333', lineHeight: 1.65 },
    // Signature
    sigBlock:   { flexDirection: 'row', gap: 40, marginTop: 28, paddingTop: 16, borderTop: `1 solid #E5E1D8` },
    sigCol:     { flex: 1 },
    sigLabel:   { fontSize: 8, color: '#909090', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 },
    sigLine:    { borderBottom: `1 solid #1A1A1A`, height: 28, marginBottom: 4 },
    sigImg:     { height: 32, maxWidth: 160, marginBottom: 4, objectFit: 'contain' },
    sigName:    { fontFamily: 'Helvetica-Bold', fontSize: 10 },
    sigDate:    { fontSize: 9, color: '#909090' },
    // Watermark
    watermark:  { position: 'absolute', top: '45%', left: '20%', fontSize: 64, color: 'rgba(0,0,0,0.04)', transform: 'rotate(-30deg)' },
    // Footer
    footer:     { flexDirection: 'row', justifyContent: 'space-between', marginTop: 28, paddingTop: 10, borderTop: `1 solid #E5E1D8`, fontSize: 8, color: '#B0B0B0' },
  })

  const sections = data.sections
    .filter(sec => sec.visible && !['parties','signature'].includes(sec.id))
    .sort((a, b) => a.order - b.order)

  return (
    <Document>
      <Page size="A4" style={s.page}>
        {data.isWatermarked && <Text style={s.watermark}>DRAFT</Text>}

        {/* Header */}
        <View style={s.header}>
          <View>
            <Text style={s.h1}>Statement of Work</Text>
            <Text style={s.meta}>{data.documentNumber ? `${data.documentNumber} · ` : ''}Version {data.version} · {data.projectName}</Text>
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
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.partyLabel}>Client</Text>
            <Text style={s.partyName}>{data.clientName}</Text>
          </View>
        </View>

        {/* Sections */}
        {sections.map(sec => (
          <View key={sec.id} style={s.section} wrap={false}>
            <Text style={s.secTitle}>{sec.title}</Text>
            <Text style={s.body}>{stripHtml(sec.content)}</Text>
          </View>
        ))}

        {/* Signature block */}
        <View style={s.sigBlock}>
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
          <Text>Scope governance by ScopeGov · scopegov.app</Text>
          <Text>Generated {fmtDate(new Date().toISOString())}</Text>
        </View>
      </Page>
    </Document>
  )
}

// ── CO PDF ───────────────────────────────────────────────────

function CoDocument({ data, logo }: { data: CoPdfData; logo: string | null }) {
  const c = data.brandColour || '#1A5C3A'

  const s = StyleSheet.create({
    page:      { fontFamily: 'Helvetica', fontSize: 10, color: '#1A1A1A', padding: '40 48' },
    header:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: `2 solid ${c}`, paddingBottom: 14, marginBottom: 20 },
    h1:        { fontFamily: 'Helvetica-Bold', fontSize: 16, color: c, marginBottom: 3 },
    meta:      { fontSize: 8.5, color: '#909090' },
    logo:      { maxHeight: 38, maxWidth: 90, objectFit: 'contain' },
    agencyText:{ fontFamily: 'Helvetica-Bold', fontSize: 11, color: c },
    noteBox:   { backgroundColor: '#F9F8F5', border: `1 solid #E5E1D8`, borderRadius: 4, padding: '10 14', marginBottom: 18, fontSize: 10, color: '#333', lineHeight: 1.6 },
    // Table
    tableHdr:  { flexDirection: 'row', borderBottom: `1 solid #E5E1D8`, paddingBottom: 5, marginBottom: 2 },
    th:        { fontSize: 8, fontFamily: 'Helvetica-Bold', color: '#909090', textTransform: 'uppercase', letterSpacing: 0.5 },
    row:       { flexDirection: 'row', borderBottom: `1 solid #F2F0EA`, paddingVertical: 8 },
    td:        { fontSize: 10, color: '#1A1A1A' },
    mono:      { fontFamily: 'Courier', fontSize: 9.5 },
    // Totals
    totals:    { marginTop: 10, paddingTop: 10, borderTop: `1 solid #E5E1D8` },
    totalRow:  { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2, fontSize: 10 },
    grandRow:  { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 6, marginTop: 4, borderTop: `1 solid #1A1A1A`, fontSize: 13, fontFamily: 'Helvetica-Bold' },
    // Sig
    sigBlock:  { flexDirection: 'row', gap: 40, marginTop: 28, paddingTop: 16, borderTop: `1 solid #E5E1D8` },
    sigCol:    { flex: 1 },
    sigLabel:  { fontSize: 8, color: '#909090', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 },
    sigLine:   { borderBottom: `1 solid #1A1A1A`, height: 26, marginBottom: 4 },
    sigImg:    { height: 30, maxWidth: 150, marginBottom: 4, objectFit: 'contain' },
    sigName:   { fontFamily: 'Helvetica-Bold', fontSize: 10 },
    footer:    { flexDirection: 'row', justifyContent: 'space-between', marginTop: 24, paddingTop: 10, borderTop: `1 solid #E5E1D8`, fontSize: 8, color: '#B0B0B0' },
  })

  const tax = data.taxRate > 0 && !data.taxInclusive
    ? data.subtotal * data.taxRate / 100
    : 0

  return (
    <Document>
      <Page size="A4" style={s.page}>
        {/* Header */}
        <View style={s.header}>
          <View>
            <Text style={s.h1}>Change Order</Text>
            <Text style={s.meta}>{data.documentNumber ? `${data.documentNumber} · ` : ''}{data.coTitle}</Text>
            <Text style={s.meta}>{data.projectName} · {data.agencyName} → {data.clientName}</Text>
            {data.acceptedAt && <Text style={[s.meta, { color: c, marginTop: 2 }]}>Accepted {fmtDate(data.acceptedAt)}</Text>}
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            {logo
              ? <Image src={logo} style={s.logo} />
              : <Text style={s.agencyText}>{data.agencyName}</Text>}
          </View>
        </View>

        {/* Note */}
        {data.note && <View style={s.noteBox}><Text>{stripHtml(data.note)}</Text></View>}

        {/* Line items table */}
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
              <Text>Tax ({data.taxRate}%)</Text>
              <Text style={s.mono}>{data.currency} {fmtMoney(tax)}</Text>
            </View>
          )}
          {data.taxInclusive && data.taxRate > 0 && (
            <View style={s.totalRow}>
              <Text style={{ color: '#909090' }}>Tax included ({data.taxRate}%)</Text>
            </View>
          )}
          <View style={s.grandRow}>
            <Text>Total</Text>
            <Text style={[s.mono, { color: c }]}>{data.currency} {fmtMoney(data.total)}</Text>
          </View>
        </View>

        {/* Signature block */}
        <View style={s.sigBlock}>
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
          <Text>Scope governance by ScopeGov · scopegov.app</Text>
          <Text>Generated {fmtDate(new Date().toISOString())}</Text>
        </View>
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
  const balanceDue = Math.max(0, data.amount - data.amountPaid)

  const s = StyleSheet.create({
    page:      { fontFamily: 'Helvetica', fontSize: 10, color: '#1A1A1A', padding: '40 48' },
    header:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: `2 solid ${c}`, paddingBottom: 14, marginBottom: 20 },
    h1:        { fontFamily: 'Helvetica-Bold', fontSize: 18, color: c, marginBottom: 3 },
    meta:      { fontSize: 8.5, color: '#909090' },
    logo:      { maxHeight: 42, maxWidth: 100, objectFit: 'contain' },
    agencyText:{ fontFamily: 'Helvetica-Bold', fontSize: 11, color: c },
    statusPill:{ fontSize: 8, fontFamily: 'Helvetica-Bold', color: c, textTransform: 'uppercase', letterSpacing: 0.5, textAlign: 'right', marginBottom: 4 },
    partiesBox:{ flexDirection: 'row', gap: 32, backgroundColor: '#F9F8F5', border: '1 solid #E5E1D8', borderRadius: 4, padding: '10 14', marginBottom: 20 },
    partyLabel:{ fontSize: 8, color: '#909090', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
    partyName: { fontFamily: 'Helvetica-Bold', fontSize: 11 },
    lineBox:   { border: '1 solid #E5E1D8', borderRadius: 4, marginBottom: 16 },
    lineRow:   { flexDirection: 'row', justifyContent: 'space-between', padding: '12 14', borderBottom: '1 solid #F2F0EA' },
    lineDesc:  { fontSize: 11, color: '#1A1A1A' },
    lineAmt:   { fontSize: 11, fontFamily: 'Courier-Bold' },
    totals:    { marginTop: 4 },
    totalRow:  { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3, fontSize: 10 },
    grandRow:  { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 8, marginTop: 6, borderTop: '1 solid #1A1A1A', fontSize: 14, fontFamily: 'Helvetica-Bold' },
    section:   { marginTop: 20 },
    secTitle:  { fontSize: 8, fontFamily: 'Helvetica-Bold', color: '#909090', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6, borderBottom: '1 solid #E5E1D8', paddingBottom: 3 },
    body:      { fontSize: 10, color: '#333', lineHeight: 1.6 },
    payRow:    { flexDirection: 'row', justifyContent: 'space-between', fontSize: 9.5, color: '#555', paddingVertical: 3, borderBottom: '1 solid #F2F0EA' },
    footer:    { flexDirection: 'row', justifyContent: 'space-between', marginTop: 28, paddingTop: 10, borderTop: '1 solid #E5E1D8', fontSize: 8, color: '#B0B0B0' },
  })

  return (
    <Document>
      <Page size="A4" style={s.page}>
        <View style={s.header}>
          <View>
            <Text style={s.h1}>Invoice</Text>
            <Text style={s.meta}>{data.invoiceNumber ? `${data.invoiceNumber} · ` : ''}{data.projectName}</Text>
            {data.sentAt && <Text style={[s.meta, { marginTop: 2 }]}>Issued {fmtDate(data.sentAt)}{data.dueDate ? ` · Due ${fmtDate(data.dueDate)}` : ''}</Text>}
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
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.partyLabel}>Billed to</Text>
            <Text style={s.partyName}>{data.clientCompany || data.clientName}</Text>
            {data.clientCompany && <Text style={{ fontSize: 9.5, color: '#666' }}>{data.clientName}</Text>}
          </View>
        </View>

        <View style={s.lineBox}>
          <View style={s.lineRow}>
            <Text style={s.lineDesc}>{data.title}</Text>
            <Text style={s.lineAmt}>{data.currency} {fmtMoney(data.amount)}</Text>
          </View>
        </View>

        <View style={s.totals}>
          <View style={s.totalRow}>
            <Text style={{ color: '#909090' }}>Amount due</Text>
            <Text style={{ fontFamily: 'Courier' }}>{data.currency} {fmtMoney(data.amount)}</Text>
          </View>
          {data.amountPaid > 0 && (
            <View style={s.totalRow}>
              <Text style={{ color: '#1A5C3A' }}>Paid to date</Text>
              <Text style={{ fontFamily: 'Courier', color: '#1A5C3A' }}>-{data.currency} {fmtMoney(data.amountPaid)}</Text>
            </View>
          )}
          <View style={s.grandRow}>
            <Text>{balanceDue > 0 ? 'Balance due' : 'Paid in full'}</Text>
            <Text style={{ color: c }}>{data.currency} {fmtMoney(balanceDue)}</Text>
          </View>
        </View>

        {data.paymentInstructions && (
          <View style={s.section}>
            <Text style={s.secTitle}>Payment instructions</Text>
            <Text style={s.body}>{stripHtml(data.paymentInstructions)}</Text>
          </View>
        )}

        {data.payments.length > 0 && (
          <View style={s.section}>
            <Text style={s.secTitle}>Payments received</Text>
            {data.payments.map((p, i) => (
              <View key={i} style={s.payRow}>
                <Text>{fmtDate(p.paidAt)} · {INVOICE_METHOD_LABEL[p.method] || p.method}{p.referenceNote ? ` · ${p.referenceNote}` : ''}</Text>
                <Text style={{ fontFamily: 'Courier' }}>{data.currency} {fmtMoney(p.amount)}</Text>
              </View>
            ))}
          </View>
        )}

        <View style={s.footer}>
          <Text>This is a payment record, not a payment portal — pay per the instructions above.</Text>
          <Text>Generated {fmtDate(new Date().toISOString())}</Text>
        </View>
      </Page>
    </Document>
  )
}

// ── Public exports (same interface as before) ─────────────────

export async function renderSowPdf(data: SowPdfData): Promise<Buffer> {
  const logo = await resolveLogoDataUri(data.agencyLogoUrl)
  return renderToBuffer(<SowDocument data={data} logo={logo} />)
}

export async function renderCoPdf(data: CoPdfData): Promise<Buffer> {
  const logo = await resolveLogoDataUri(data.logoUrl)
  return renderToBuffer(<CoDocument data={data} logo={logo} />)
}

export async function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  const logo = await resolveLogoDataUri(data.logoUrl)
  return renderToBuffer(<InvoiceDocument data={data} logo={logo} />)
}

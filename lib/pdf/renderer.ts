// lib/pdf/renderer.ts
// BUG-013: Puppeteer uses Node.js APIs. This file must ONLY be imported
// from routes with `export const runtime = 'nodejs'` as literal line 1.
// Never import from edge runtime files.

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
  version:       number
  isWatermarked?: boolean
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
  isPartial?:   boolean
  partialNote?: string
}

// Carry-forward §10.3: logos must be base64 data URIs — never remote URLs in PDFs
export async function resolveLogoDataUri(url: string | null | undefined): Promise<string | null> {
  if (!url) return null
  if (url.startsWith('data:')) return url
  try {
    const res  = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const buf  = await res.arrayBuffer()
    const mime = res.headers.get('content-type') ?? 'image/png'
    return `data:${mime};base64,${Buffer.from(buf).toString('base64')}`
  } catch { return null }
}

function buildSowHtml(data: SowPdfData, logoDataUri: string | null): string {
  const c         = data.brandColour || '#1A5C3A'
  const sections  = data.sections
    .filter(s => s.visible)
    .sort((a, b) => a.order - b.order)

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, 'Segoe UI', Arial, sans-serif; font-size: 11px; color: #1A1A1A; background: #FFF; line-height: 1.6; }
    .page { padding: 40px 48px; max-width: 760px; margin: 0 auto; }
    /* Header */
    .header { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 20px; margin-bottom: 24px; border-bottom: 2px solid ${c}; }
    .header-left h1 { font-family: Georgia, serif; font-size: 22px; font-weight: 400; color: ${c}; margin-bottom: 4px; }
    .header-left .meta { font-size: 10px; color: #909090; }
    .logo { max-height: 50px; max-width: 120px; object-fit: contain; }
    .agency-text { font-size: 14px; font-weight: 600; color: ${c}; }
    .header-right { text-align: right; }
    .header-right .value { font-family: Georgia, serif; font-size: 20px; color: ${c}; }
    .header-right .value-label { font-size: 9px; color: #909090; text-transform: uppercase; letter-spacing: .06em; }
    /* Parties box */
    .parties-box { background: #F9F8F5; border: 1px solid #E5E1D8; border-radius: 5px; padding: 14px 16px; margin-bottom: 24px; display: flex; gap: 40px; }
    .party h4 { font-size: 9px; text-transform: uppercase; letter-spacing: .07em; color: #909090; margin-bottom: 5px; }
    .party p { font-size: 12px; font-weight: 500; }
    /* Sections */
    .section { margin-bottom: 22px; page-break-inside: avoid; }
    .section-title { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: #909090; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid #E5E1D8; }
    .section-body { font-size: 11px; color: #333; line-height: 1.7; }
    .section-body p { margin-bottom: 6px; }
    .section-body ul, .section-body ol { padding-left: 18px; margin-bottom: 6px; }
    .section-body li { margin-bottom: 3px; }
    .section-body strong { font-weight: 600; }
    /* Signature block */
    .sig-block { margin-top: 32px; padding-top: 20px; border-top: 1px solid #E5E1D8; display: flex; gap: 48px; }
    .sig-col { flex: 1; }
    .sig-label { font-size: 9px; color: #909090; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 12px; }
    .sig-line { border-bottom: 1px solid #1A1A1A; height: 32px; margin-bottom: 6px; }
    .sig-name { font-size: 11px; font-weight: 500; }
    .sig-date { font-size: 10px; color: #909090; }
    /* Watermark */
    .watermark { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%) rotate(-30deg); font-family: Georgia, serif; font-size: 72px; color: rgba(0,0,0,0.04); pointer-events: none; white-space: nowrap; z-index: 9999; }
    /* Footer */
    .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #E5E1D8; font-size: 9px; color: #B0B0B0; display: flex; justify-content: space-between; }
    a { color: ${c}; text-decoration: none; }
  </style>
</head>
<body>
  ${data.isWatermarked ? '<div class="watermark">DRAFT</div>' : ''}
  <div class="page">
    <!-- Header -->
    <div class="header">
      <div class="header-left">
        <h1>Statement of Work</h1>
        <div class="meta">Version ${data.version} · ${data.projectName}</div>
        ${data.signedAt ? `<div class="meta" style="color:${c};margin-top:3px;">Signed ${new Date(data.signedAt).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})}</div>` : ''}
      </div>
      <div class="header-right">
        ${logoDataUri
          ? `<img src="${logoDataUri}" class="logo" alt="${data.agencyName}" style="margin-bottom:8px;display:block;margin-left:auto;">`
          : `<div class="agency-text">${data.agencyName}</div>`}
        <div class="value">${data.currency} ${data.contractValue.toLocaleString()}</div>
        <div class="value-label">Contract value</div>
      </div>
    </div>

    <!-- Parties -->
    <div class="parties-box">
      <div class="party">
        <h4>Agency (Service Provider)</h4>
        <p>${data.agencyName}</p>
      </div>
      <div class="party">
        <h4>Client</h4>
        <p>${data.clientName}</p>
      </div>
    </div>

    <!-- Sections -->
    ${sections
      .filter(s => !['parties','signature'].includes(s.id))
      .map(s => `
      <div class="section">
        <div class="section-title">${s.title}</div>
        <div class="section-body">${s.content}</div>
      </div>
    `).join('')}

    <!-- Signature block -->
    <div class="sig-block">
      <div class="sig-col">
        <div class="sig-label">Agency — ${data.agencyName}</div>
        <div class="sig-line"></div>
        <div class="sig-name">${data.agencyName}</div>
      </div>
      <div class="sig-col">
        <div class="sig-label">Client — ${data.clientName}</div>
        <div class="sig-line" style="${data.signedBy ? `border-bottom:2px solid ${c}` : ''}"></div>
        ${data.signedBy
          ? `<div class="sig-name" style="color:${c};">${data.signedBy}</div>
             <div class="sig-date">${data.signedAt ? new Date(data.signedAt).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'}) : ''}</div>`
          : `<div class="sig-name" style="color:#B0B0B0;">Not yet signed</div>`}
      </div>
    </div>

    <!-- Footer -->
    <div class="footer">
      <span>Scope governance by <a href="https://scopegov.app">ScopeGov</a></span>
      <span>Generated ${new Date().toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})}</span>
    </div>
  </div>
</body>
</html>`
}

function buildCoHtml(data: CoPdfData, logoDataUri: string | null): string {
  const c = data.brandColour || '#1A5C3A'

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, 'Segoe UI', Arial, sans-serif; font-size: 11px; color: #1A1A1A; background: #FFF; }
    .page { padding: 40px 48px; max-width: 760px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 20px; margin-bottom: 24px; border-bottom: 2px solid ${c}; }
    .header-left h1 { font-family: Georgia, serif; font-size: 20px; font-weight: 400; color: ${c}; margin-bottom: 4px; }
    .meta { font-size: 10px; color: #909090; }
    .logo { max-height: 44px; max-width: 110px; object-fit: contain; }
    .agency-text { font-size: 13px; font-weight: 600; color: ${c}; }
    .table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    .table th { font-size: 9px; text-transform: uppercase; letter-spacing: .07em; color: #909090; text-align: left; padding: 8px 0; border-bottom: 1px solid #E5E1D8; }
    .table th.right { text-align: right; }
    .table td { padding: 10px 0; border-bottom: 1px solid #F2F0EA; font-size: 11px; vertical-align: top; line-height: 1.5; }
    .table td.right { text-align: right; font-family: 'Courier New', monospace; }
    .totals { margin-top: 12px; padding-top: 12px; border-top: 1px solid #E5E1D8; }
    .total-row { display: flex; justify-content: space-between; font-size: 11px; padding: 3px 0; }
    .total-row.grand { font-size: 14px; font-weight: 600; padding-top: 8px; border-top: 1px solid #1A1A1A; margin-top: 4px; }
    .total-val { font-family: 'Courier New', monospace; }
    .note-box { background: #F9F8F5; border: 1px solid #E5E1D8; border-radius: 5px; padding: 12px 14px; margin-bottom: 20px; font-size: 11px; line-height: 1.65; }
    .sig-block { margin-top: 32px; padding-top: 20px; border-top: 1px solid #E5E1D8; display: flex; gap: 40px; }
    .sig-col { flex: 1; }
    .sig-label { font-size: 9px; color: #909090; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 12px; }
    .sig-line { border-bottom: 1px solid #1A1A1A; height: 30px; margin-bottom: 5px; }
    .sig-name { font-size: 11px; font-weight: 500; }
    .footer { margin-top: 28px; padding-top: 10px; border-top: 1px solid #E5E1D8; font-size: 9px; color: #B0B0B0; display: flex; justify-content: space-between; }
    a { color: ${c}; }
  </style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="header-left">
      <h1>Change Order</h1>
      <div class="meta">${data.coTitle}</div>
      <div class="meta" style="margin-top:2px;">${data.projectName} · ${data.agencyName} → ${data.clientName}</div>
      ${data.acceptedAt ? `<div class="meta" style="color:${c};margin-top:3px;">Accepted ${new Date(data.acceptedAt).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})}</div>` : ''}
    </div>
    <div style="text-align:right;">
      ${logoDataUri
        ? `<img src="${logoDataUri}" class="logo" style="margin-bottom:6px;display:block;margin-left:auto;">`
        : `<div class="agency-text">${data.agencyName}</div>`}
    </div>
  </div>

  ${data.note ? `<div class="note-box">${data.note.replace(/<[^>]+>/g, ' ')}</div>` : ''}

  <table class="table">
    <thead>
      <tr>
        <th>Description</th>
        <th style="width:50px;text-align:center;">Qty</th>
        <th style="width:90px;text-align:right;">Rate</th>
        <th style="width:90px;" class="right">Total</th>
      </tr>
    </thead>
    <tbody>
      ${data.lineItems.map(item => `
        <tr>
          <td>${item.description}</td>
          <td style="text-align:center;">${item.quantity}</td>
          <td class="right">${data.currency} ${item.rate.toLocaleString()}</td>
          <td class="right">${data.currency} ${item.total.toLocaleString()}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>

  <div class="totals">
    <div class="total-row">
      <span>Subtotal</span>
      <span class="total-val">${data.currency} ${data.subtotal.toLocaleString()}</span>
    </div>
    ${data.taxRate > 0 && !data.taxInclusive ? `
    <div class="total-row">
      <span>Tax (${data.taxRate}%)</span>
      <span class="total-val">${data.currency} ${(data.subtotal * data.taxRate / 100).toLocaleString()}</span>
    </div>` : ''}
    ${data.taxInclusive && data.taxRate > 0 ? `<div class="total-row meta">Tax included (${data.taxRate}%)</div>` : ''}
    <div class="total-row grand">
      <span>Total</span>
      <span class="total-val" style="color:${c};">${data.currency} ${data.total.toLocaleString()}</span>
    </div>
  </div>

  <div class="sig-block">
    <div class="sig-col">
      <div class="sig-label">Agency — ${data.agencyName}</div>
      <div class="sig-line"></div>
      <div class="sig-name">${data.agencyName}</div>
    </div>
    <div class="sig-col">
      <div class="sig-label">Client — ${data.clientName}</div>
      <div class="sig-line" style="${data.acceptedBy ? `border-bottom:2px solid ${c}` : ''}"></div>
      ${data.acceptedBy
        ? `<div class="sig-name" style="color:${c};">${data.acceptedBy}</div>
           <div style="font-size:10px;color:#909090;">${data.acceptedAt ? new Date(data.acceptedAt).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'}) : ''}</div>`
        : `<div class="sig-name" style="color:#B0B0B0;">Pending</div>`}
    </div>
  </div>

  <div class="footer">
    <span>Scope governance by <a href="https://scopegov.app">ScopeGov</a></span>
    <span>Generated ${new Date().toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})}</span>
  </div>
</div>
</body>
</html>`
}

export async function renderSowPdf(data: SowPdfData): Promise<Buffer> {
  const logoDataUri = await resolveLogoDataUri(data.agencyLogoUrl)
  const html        = buildSowHtml(data, logoDataUri)
  return renderHtmlToPdf(html)
}

export async function renderCoPdf(data: CoPdfData): Promise<Buffer> {
  const logoDataUri = await resolveLogoDataUri(data.logoUrl)
  const html        = buildCoHtml(data, logoDataUri)
  return renderHtmlToPdf(html)
}

async function renderHtmlToPdf(html: string): Promise<Buffer> {
  // Dynamic import — Puppeteer only available in Node runtime
  const puppeteer = await import('puppeteer')
  const browser   = await puppeteer.default.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 })
    const pdf  = await page.pdf({
      format:           'A4',
      printBackground:  true,
      margin:           { top: '0', right: '0', bottom: '0', left: '0' },
    })
    // BUG-041: renderPdf returns Buffer not ArrayBuffer
    return Buffer.from(pdf)
  } finally {
    await browser.close()
  }
}

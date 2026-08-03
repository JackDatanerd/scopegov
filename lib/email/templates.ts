export const runtime = 'nodejs'

import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)
const FROM   = process.env.RESEND_FROM_EMAIL || 'noreply@mail.scopegov.app'
const BRAND_FROM = (agencyName: string) => `${agencyName} via ScopeGov`

// ── Color system ──────────────────────────────────────────────
const C = {
  green:    '#1A5C3A',
  greenLt:  '#EDFAF2',
  gold:     '#92680A',
  goldLt:   '#FBF5E6',
  red:      '#B91C1C',
  redLt:    '#FEF2F2',
  amber:    '#B45309',
  amberLt:  '#FFFBEB',
  text:     '#1A1A1A',
  text2:    '#555555',
  text3:    '#909090',
  border:   '#E5E1D8',
  bg:       '#F2F0EA',
  surface:  '#FFFFFF',
}

function baseTemplate({
  agencyName, headerColour = C.green, headerIcon = '⚖️',
  label, headline, body, cta, ctaUrl, ctaSecondary, footerNote,
}: {
  agencyName: string
  headerColour?: string
  headerIcon?: string
  label: string
  headline: string
  body: string
  cta?: string
  ctaUrl?: string
  ctaSecondary?: string
  footerNote?: string
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light">
</head>
<body style="margin:0;padding:0;background:${C.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','IBM Plex Sans',sans-serif;">
  <div style="max-width:580px;margin:40px auto;padding:0 20px 40px;">

    <!-- Header -->
    <div style="background:${headerColour};border-radius:8px 8px 0 0;padding:22px 28px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:3px;">
        <span style="font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.6);">
          ${label}
        </span>
      </div>
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;color:#FFF;font-weight:400;line-height:1.3;">
        ${headline}
      </div>
    </div>

    <!-- Body -->
    <div style="background:${C.surface};border:1px solid ${C.border};border-top:none;border-radius:0 0 8px 8px;padding:28px;">
      ${body}
      ${cta && ctaUrl ? `
      <div style="margin:24px 0;">
        <a href="${ctaUrl}" style="display:inline-block;background:${C.green};color:#FFF;padding:12px 24px;border-radius:5px;font-size:13px;font-weight:600;text-decoration:none;letter-spacing:.01em;">
          ${cta}
        </a>
      </div>
      ` : ''}
      ${ctaSecondary ? `<p style="font-size:12px;color:${C.text3};margin-top:16px;">${ctaSecondary}</p>` : ''}
      ${footerNote ? `<p style="font-size:12px;color:${C.text3};border-top:1px solid ${C.border};padding-top:14px;margin-top:20px;">${footerNote}</p>` : ''}
    </div>

    <!-- Footer -->
    <div style="text-align:center;margin-top:20px;">
      <p style="font-size:11px;color:${C.text3};margin:0;">
        Sent by <a href="https://scopegov.app" style="color:${C.green};text-decoration:none;">ScopeGov</a>
        on behalf of ${agencyName} &middot; Scope governance for agencies
      </p>
    </div>
  </div>
</body>
</html>`
}

// ── Event 1: SOW sent ─────────────────────────────────────────
export async function sendSowEmail(params: {
  to: string; cc?: string[]; clientName: string; agencyName: string
  projectName: string; contractValue: number; currency: string
  portalUrl: string; brandColour?: string; expiresAt: string
}) {
  const { to, cc, clientName, agencyName, projectName, contractValue,
    currency, portalUrl, brandColour, expiresAt } = params

  const expiryDate = new Date(expiresAt).toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' })

  const html = baseTemplate({
    agencyName,
    headerColour: brandColour || C.green,
    label: 'Statement of Work',
    headline: `Please review and sign your project agreement`,
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">
        Hi ${clientName},
      </p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        <strong>${agencyName}</strong> has prepared a Statement of Work for
        <strong>${projectName}</strong>. Please review the full scope and terms,
        then sign to confirm your agreement and kick off the project.
      </p>
      <div style="background:${C.bg};border:1px solid ${C.border};border-radius:6px;padding:16px 18px;margin:20px 0;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:${C.text3};margin-bottom:8px;">Summary</div>
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid ${C.border};font-size:13px;">
          <span style="color:${C.text2};">Project</span>
          <span style="font-weight:500;color:${C.text};">${projectName}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid ${C.border};font-size:13px;">
          <span style="color:${C.text2};">Agency</span>
          <span style="font-weight:500;color:${C.text};">${agencyName}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;">
          <span style="color:${C.text2};">Contract value</span>
          <span style="font-weight:600;color:${C.green};">${currency} ${contractValue.toLocaleString()}</span>
        </div>
      </div>
      <p style="font-size:12px;color:${C.text3};margin:0;">
        This link expires on ${expiryDate}. After that, please contact ${agencyName} for a new link.
      </p>
    `,
    cta: 'Review & Sign Agreement →',
    ctaUrl: portalUrl,
    ctaSecondary: `Or paste this link into your browser:<br><span style="font-family:monospace;font-size:11px;word-break:break-all;">${portalUrl}</span>`,
  })

  return resend.emails.send({
    from:    `${BRAND_FROM(agencyName)} <${FROM}>`,
    to,
    cc:      cc?.filter(Boolean) || [],
    subject: `Action required: Review your ${projectName} SOW`,
    html,
  })
}

// ── Event 3: SOW signed (agency notification) ─────────────────
export async function sendSowSignedAgencyEmail(params: {
  to: string[]; agencyName: string; clientName: string
  projectName: string; signedBy: string; portalUrl: string
  attachments?: Array<{ filename: string; content: string }>
}) {
  const { to, agencyName, clientName, projectName, signedBy, attachments } = params

  const html = baseTemplate({
    agencyName,
    headerColour: C.green,
    label: 'Agreement signed',
    headline: `${clientName} has signed the SOW`,
    body: `
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        Your client has reviewed and signed the Statement of Work for
        <strong>${projectName}</strong>. Guardian is now active and monitoring
        all project communications for scope drift.
      </p>
      <div style="background:${C.greenLt};border:1px solid #B7DCC8;border-radius:6px;padding:14px 16px;margin:16px 0;font-size:13px;color:${C.green};">
        <strong>Signed by:</strong> ${signedBy}<br>
        <strong>Guardian:</strong> Now active on this project
      </div>
      <p style="font-size:13px;color:${C.text2};margin:0;">
        A signed PDF copy has been attached to this email for your records.
      </p>
    `,
  })

  return resend.emails.send({
    from:    `ScopeGov <${FROM}>`,
    to,
    subject: `✓ ${clientName} signed the ${projectName} SOW`,
    html,
    ...(attachments?.length ? { attachments } : {}),
  })
}

// ── Event 4: SOW signed (client confirmation) ─────────────────
export async function sendSowSignedClientEmail(params: {
  to: string; clientName: string; agencyName: string
  projectName: string; portalUrl: string
  attachments?: Array<{ filename: string; content: string }>
}) {
  const { to, clientName, agencyName, projectName, portalUrl, attachments } = params

  const html = baseTemplate({
    agencyName,
    headerColour: C.green,
    label: 'Signing confirmation',
    headline: 'Your agreement is confirmed',
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${clientName},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        This confirms you have signed the Statement of Work for <strong>${projectName}</strong>
        with <strong>${agencyName}</strong>. A PDF copy is attached for your records.
      </p>
      <p style="font-size:13px;color:${C.text2};">
        If you have any questions about the project, please contact ${agencyName} directly.
      </p>
    `,
    cta: 'View your signed agreement',
    ctaUrl: portalUrl,
  })

  return resend.emails.send({
    from:    `${BRAND_FROM(agencyName)} <${FROM}>`,
    to,
    subject: `Your ${projectName} agreement is confirmed`,
    html,
    ...(attachments?.length ? { attachments } : {}),
  })
}

// ── Event 5: SOW declined ─────────────────────────────────────
export async function sendSowDeclinedEmail(params: {
  to: string[]; agencyName: string; clientName: string
  projectName: string; reason?: string
}) {
  const { to, agencyName, clientName, projectName, reason } = params

  const html = baseTemplate({
    agencyName,
    headerColour: C.red,
    label: 'SOW declined',
    headline: `${clientName} declined the SOW`,
    body: `
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        Your client has declined the Statement of Work for <strong>${projectName}</strong>.
      </p>
      ${reason ? `
      <div style="background:${C.redLt};border:1px solid #FECACA;border-radius:6px;padding:14px 16px;margin:16px 0;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:${C.red};margin-bottom:6px;">Reason given</div>
        <p style="font-size:13px;color:${C.text};margin:0;">${reason}</p>
      </div>
      ` : ''}
      <p style="font-size:13px;color:${C.text2};margin:0;">
        Review the feedback, revise the SOW in ScopeGov, and resend when ready.
      </p>
    `,
    cta: 'Open project in ScopeGov',
    ctaUrl: `${process.env.NEXT_PUBLIC_APP_URL}/projects`,
  })

  return resend.emails.send({
    from:    `ScopeGov <${FROM}>`,
    to,
    subject: `Client declined the ${projectName} SOW`,
    html,
  })
}

// ── Event 18: Guardian flag raised ────────────────────────────
export async function sendGuardianFlagEmail(params: {
  to: string[]; agencyName: string; projectName: string
  severity: string; description: string; sowReference: string
  projectUrl: string; path?: string
}) {
  const { to, agencyName, projectName, severity, description, sowReference, projectUrl, path } = params

  const severityColour = severity === 'high' ? C.red : severity === 'medium' ? C.amber : C.text3
  const severityBg     = severity === 'high' ? C.redLt : severity === 'medium' ? C.amberLt : C.bg

  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: severityColour,
    label: `${severity.toUpperCase()} scope flag`,
    headline: `Scope flag raised on ${projectName}`,
    body: `
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        Guardian detected a potential out-of-scope request on <strong>${projectName}</strong>.
        ${path ? `<br><em>Source: ${path}</em>` : ''}
      </p>
      <div style="background:${severityBg};border-left:3px solid ${severityColour};padding:14px 16px;margin:16px 0;border-radius:0 6px 6px 0;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:${severityColour};margin-bottom:8px;">
          ${severity} confidence · Out of scope
        </div>
        <p style="font-size:13px;color:${C.text};line-height:1.6;margin:0 0 8px;">${description}</p>
        <p style="font-size:12px;color:${C.text3};margin:0;font-style:italic;">SOW reference: ${sowReference}</p>
      </div>
      <p style="font-size:13px;color:${C.text2};">
        Review the flag and decide: draft a change order, grant an exception, or mark it in-scope.
      </p>
    `,
    cta: 'Review flag in ScopeGov →',
    ctaUrl: projectUrl,
  })

  return resend.emails.send({
    from:    `ScopeGov Guardian <${FROM}>`,
    to,
    subject: `[${severity.toUpperCase()}] Scope flag on ${projectName}`,
    html,
  })
}

// ── Event 20: Invite sent ─────────────────────────────────────
export async function sendInviteEmail(params: {
  to: string; inviterName: string; workspaceName: string
  agencyName: string; inviteUrl: string; expiresAt: string
}) {
  const { to, inviterName, workspaceName, agencyName, inviteUrl, expiresAt } = params

  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.green,
    label: 'Workspace invitation',
    headline: `You're invited to join ${workspaceName}`,
    body: `
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        <strong>${inviterName}</strong> has invited you to join <strong>${workspaceName}</strong>
        on ScopeGov — the scope governance platform for agencies.
      </p>
      <p style="font-size:13px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        As a team member, you&apos;ll be able to collaborate on projects, SOWs, change orders,
        and Guardian scope monitoring.
      </p>
      <p style="font-size:12px;color:${C.text3};margin:0;">
        This invitation expires on ${new Date(expiresAt).toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' })}.
      </p>
    `,
    cta: 'Accept invitation →',
    ctaUrl: inviteUrl,
  })

  return resend.emails.send({
    from:    `ScopeGov <${FROM}>`,
    to,
    subject: `${inviterName} invited you to join ${workspaceName} on ScopeGov`,
    html,
  })
}

// ── Event 26: Trial ending soon ───────────────────────────────
export async function sendTrialWarningEmail(params: {
  to: string; name: string; agencyName: string
  daysLeft: number; upgradeUrl: string
}) {
  const { to, name, agencyName, daysLeft, upgradeUrl } = params

  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: daysLeft <= 1 ? C.red : C.amber,
    label: 'Trial ending',
    headline: daysLeft === 0
      ? 'Your trial has ended'
      : `Your trial ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`,
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${name},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        ${daysLeft === 0
          ? `The trial period for <strong>${agencyName}</strong>'s ScopeGov workspace has ended. Upgrade to continue protecting your scope.`
          : `The trial for <strong>${agencyName}</strong>'s ScopeGov workspace ends in <strong>${daysLeft} day${daysLeft !== 1 ? 's' : ''}</strong>. Upgrade now to keep access to all your projects, SOWs, and Guardian history.`}
      </p>
      <p style="font-size:13px;color:${C.text2};">
        Your data is safe — nothing is deleted. Choose a plan to continue.
      </p>
    `,
    cta: 'Upgrade your plan →',
    ctaUrl: upgradeUrl,
  })

  return resend.emails.send({
    from:    `ScopeGov <${FROM}>`,
    to,
    subject: daysLeft === 0
      ? `Your ScopeGov trial has ended — upgrade to continue`
      : `${daysLeft} day${daysLeft !== 1 ? 's' : ''} left on your ScopeGov trial`,
    html,
  })
}

// ── Event 24: Escalation notification ────────────────────────
export async function sendEscalationEmail(params: {
  to: string; assigneeName: string; agencyName: string
  entityType: string; entityName: string; note: string; url: string
}) {
  const { to, assigneeName, agencyName, entityType, entityName, note, url } = params

  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.amber,
    label: 'Escalation',
    headline: `A matter has been escalated to you`,
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${assigneeName},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        A ${entityType} on <strong>${entityName}</strong> has been escalated to you for review.
      </p>
      <div style="background:${C.amberLt};border-left:3px solid ${C.amber};padding:14px 16px;margin:16px 0;border-radius:0 6px 6px 0;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:${C.amber};margin-bottom:6px;">Escalation note</div>
        <p style="font-size:13px;color:${C.text};margin:0;">${note}</p>
      </div>
    `,
    cta: 'Review in ScopeGov →',
    ctaUrl: url,
  })

  return resend.emails.send({
    from:    `ScopeGov <${FROM}>`,
    to,
    subject: `Escalated to you: ${entityName}`,
    html,
  })
}

// ── Event 9: CO sent ──────────────────────────────────────────
export async function sendCoEmail(params: {
  to: string; cc?: string[]; clientName: string; agencyName: string
  projectName: string; coTitle: string; total: number; currency: string
  portalUrl: string; brandColour?: string; note?: string
}) {
  const { to, cc, clientName, agencyName, projectName, coTitle, total, currency,
    portalUrl, brandColour, note } = params

  const html = baseTemplate({
    agencyName,
    headerColour: brandColour || C.green,
    label: 'Change Order',
    headline: `Change order for ${projectName}`,
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${clientName},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        <strong>${agencyName}</strong> has sent a change order for <strong>${projectName}</strong>.
        Please review the scope additions and respond.
      </p>
      ${note ? `
      <div style="background:${C.bg};border:1px solid ${C.border};border-radius:6px;padding:14px 16px;margin:16px 0;">
        <p style="font-size:13px;color:${C.text2};margin:0;line-height:1.6;">${note}</p>
      </div>
      ` : ''}
      <div style="background:${C.bg};border:1px solid ${C.border};border-radius:6px;padding:14px 16px;margin:16px 0;">
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0;">
          <span style="color:${C.text2};">${coTitle}</span>
          <span style="font-weight:600;color:${C.green};">${currency} ${total.toLocaleString()}</span>
        </div>
      </div>
    `,
    cta: 'Review & respond to change order →',
    ctaUrl: portalUrl,
  })

  return resend.emails.send({
    from:    `${BRAND_FROM(agencyName)} <${FROM}>`,
    to,
    cc:      cc?.filter(Boolean) || [],
    subject: `Change order: ${coTitle} — ${projectName}`,
    html,
  })
}

// ── Event 11: CO accepted (agency) ───────────────────────────
export async function sendCoAcceptedEmail(params: {
  to: string[]; agencyName: string; clientName: string
  projectName: string; coTitle: string; total: number
  currency: string; acceptedBy: string; projectUrl: string
}) {
  const { to, agencyName, clientName, projectName, coTitle, total, currency, acceptedBy, projectUrl } = params

  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.green,
    label: 'Change order accepted',
    headline: `${clientName} accepted the change order`,
    body: `
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        Great news — <strong>${clientName}</strong> has accepted the change order
        <strong>${coTitle}</strong> on <strong>${projectName}</strong>.
      </p>
      <div style="background:${C.greenLt};border:1px solid #B7DCC8;border-radius:6px;padding:14px 16px;margin:16px 0;font-size:13px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
          <span style="color:${C.green};">Additional value locked in</span>
          <strong style="color:${C.green};">${currency} ${total.toLocaleString()}</strong>
        </div>
        <div style="font-size:12px;color:${C.text3};">Signed by: ${acceptedBy}</div>
      </div>
      <p style="font-size:13px;color:${C.text2};">
        An amendment has been created and the contract value updated automatically.
      </p>
    `,
    cta: 'View project →',
    ctaUrl: projectUrl,
  })

  return resend.emails.send({
    from:    `ScopeGov <${FROM}>`,
    to,
    subject: `✓ Change order accepted — ${projectName} +${currency} ${total.toLocaleString()}`,
    html,
  })
}

// ── Payment failed / grace period ────────────────────────────
export async function sendPaymentFailedEmail(params: {
  to: string; name: string; agencyName: string
  upgradeUrl: string; graceDaysLeft: number
}) {
  const { to, name, agencyName, upgradeUrl, graceDaysLeft } = params

  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.red,
    label: 'Payment failed',
    headline: 'Your payment did not go through',
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${name},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        We were unable to process the payment for <strong>${agencyName}</strong>&apos;s ScopeGov subscription.
        You have a <strong>${graceDaysLeft}-day grace period</strong> to update your payment details.
      </p>
      <p style="font-size:13px;color:${C.text2};">
        If the payment is not resolved within ${graceDaysLeft} days, your plan will be downgraded.
        Your data will never be deleted.
      </p>
    `,
    cta: 'Update payment details →',
    ctaUrl: upgradeUrl,
  })

  return resend.emails.send({
    from:    `ScopeGov <${FROM}>`,
    to,
    subject: `Action needed: Payment failed for ScopeGov — ${graceDaysLeft} days to resolve`,
    html,
  })
}

// ── Phase 4a: Invoice sent (client-facing) ──────────────────────
export async function sendInvoiceEmail(params: {
  to: string; cc?: string[]; clientName: string; agencyName: string
  projectName: string; invoiceNumber?: string | null; title: string
  amount: number; currency: string; dueDate?: string | null
  portalUrl: string; brandColour?: string; paymentInstructions?: string | null
}) {
  const { to, cc, clientName, agencyName, projectName, invoiceNumber, title,
    amount, currency, dueDate, portalUrl, brandColour, paymentInstructions } = params

  const html = baseTemplate({
    agencyName,
    headerColour: brandColour || C.green,
    label: invoiceNumber ? `Invoice ${invoiceNumber}` : 'Invoice',
    headline: `Invoice for ${projectName}`,
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${clientName},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        <strong>${agencyName}</strong> has sent an invoice for <strong>${projectName}</strong>.
      </p>
      <div style="background:${C.bg};border:1px solid ${C.border};border-radius:6px;padding:14px 16px;margin:16px 0;">
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0;">
          <span style="color:${C.text2};">${title}</span>
          <span style="font-weight:600;color:${C.green};">${currency} ${amount.toLocaleString()}</span>
        </div>
        ${dueDate ? `<div style="font-size:12px;color:${C.text3};margin-top:6px;">Due ${new Date(dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</div>` : ''}
      </div>
      ${paymentInstructions ? `
      <div style="background:${C.bg};border:1px solid ${C.border};border-radius:6px;padding:14px 16px;margin:16px 0;">
        <p style="font-size:11px;color:${C.text3};text-transform:uppercase;letter-spacing:.05em;margin:0 0 6px;">Payment instructions</p>
        <p style="font-size:13px;color:${C.text2};margin:0;line-height:1.6;white-space:pre-line;">${paymentInstructions}</p>
      </div>
      ` : ''}
    `,
    cta: 'View invoice →',
    ctaUrl: portalUrl,
    footerNote: 'This invoice is issued and tracked via ScopeGov on behalf of the agency above. ScopeGov does not process this payment — pay per the instructions provided by the agency.',
  })

  return resend.emails.send({
    from:    `${BRAND_FROM(agencyName)} <${FROM}>`,
    to,
    cc:      cc?.filter(Boolean) || [],
    subject: `Invoice${invoiceNumber ? ` ${invoiceNumber}` : ''}: ${title} — ${projectName}`,
    html,
  })
}

// ── Phase 4a: Invoice reminder (client-facing) ───────────────────
export async function sendInvoiceReminderEmail(params: {
  to: string; cc?: string[]; clientName: string; agencyName: string
  projectName: string; invoiceNumber?: string | null; title: string
  balanceDue: number; currency: string; dueDate?: string | null
  portalUrl: string; brandColour?: string; isOverdue?: boolean
}) {
  const { to, cc, clientName, agencyName, projectName, invoiceNumber, title,
    balanceDue, currency, dueDate, portalUrl, brandColour, isOverdue } = params

  const html = baseTemplate({
    agencyName,
    headerColour: isOverdue ? C.amber : (brandColour || C.green),
    label: 'Payment reminder',
    headline: isOverdue ? `Overdue: ${title}` : `Reminder: ${title}`,
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${clientName},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        A friendly reminder that <strong>${currency} ${balanceDue.toLocaleString()}</strong> is
        ${isOverdue ? 'now overdue' : 'outstanding'} on invoice${invoiceNumber ? ` ${invoiceNumber}` : ''} for
        <strong>${projectName}</strong>.
        ${dueDate ? ` Due date was ${new Date(dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.` : ''}
      </p>
    `,
    cta: 'View invoice →',
    ctaUrl: portalUrl,
  })

  return resend.emails.send({
    from:    `${BRAND_FROM(agencyName)} <${FROM}>`,
    to,
    cc:      cc?.filter(Boolean) || [],
    subject: `${isOverdue ? 'Overdue' : 'Reminder'}: Invoice${invoiceNumber ? ` ${invoiceNumber}` : ''} — ${projectName}`,
    html,
  })
}

// ── Phase 4a: Payment recorded (internal, agency-facing) ─────────
export async function sendInvoicePaymentRecordedEmail(params: {
  to: string[]; agencyName: string; clientName: string; projectName: string
  invoiceNumber?: string | null; amount: number; currency: string
  isFullyPaid: boolean; balanceRemaining: number; projectUrl: string
}) {
  const { to, clientName, projectName, invoiceNumber, amount, currency,
    isFullyPaid, balanceRemaining, projectUrl } = params
  if (to.length === 0) return

  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.green,
    label: 'Payment recorded',
    headline: isFullyPaid ? `Invoice${invoiceNumber ? ` ${invoiceNumber}` : ''} paid in full` : `Payment received`,
    body: `
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        A payment of <strong>${currency} ${amount.toLocaleString()}</strong> from <strong>${clientName}</strong>
        was recorded on <strong>${projectName}</strong>.
      </p>
      ${!isFullyPaid ? `<p style="font-size:13px;color:${C.text2};">Remaining balance: <strong>${currency} ${balanceRemaining.toLocaleString()}</strong></p>` : ''}
    `,
    cta: 'View project →',
    ctaUrl: projectUrl,
  })

  return resend.emails.send({
    from:    `ScopeGov <${FROM}>`,
    to,
    subject: isFullyPaid
      ? `✓ Invoice paid in full — ${projectName} (${currency} ${amount.toLocaleString()})`
      : `Payment received — ${projectName} (${currency} ${amount.toLocaleString()})`,
    html,
  })
}

// ── Phase 4a: Invoice overdue (internal, agency-facing) ──────────
export async function sendInvoiceOverdueInternalEmail(params: {
  to: string[]; clientName: string; projectName: string
  invoiceNumber?: string | null; balanceDue: number; currency: string; projectUrl: string
}) {
  const { to, clientName, projectName, invoiceNumber, balanceDue, currency, projectUrl } = params
  if (to.length === 0) return

  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.amber,
    label: 'Invoice overdue',
    headline: `${clientName} has an overdue invoice`,
    body: `
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        Invoice${invoiceNumber ? ` ${invoiceNumber}` : ''} on <strong>${projectName}</strong> passed its due date
        with <strong>${currency} ${balanceDue.toLocaleString()}</strong> still outstanding.
      </p>
    `,
    cta: 'View project →',
    ctaUrl: projectUrl,
  })

  return resend.emails.send({
    from:    `ScopeGov <${FROM}>`,
    to,
    subject: `Overdue: ${clientName} — ${currency} ${balanceDue.toLocaleString()} (${projectName})`,
    html,
  })
}

// ── Security: MFA enabled ────────────────────────────────────
export async function sendMfaEnabledEmail(params: { to: string; name: string }) {
  const { to, name } = params
  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.green,
    headerIcon: '🔐',
    label: 'Security',
    headline: 'Two-factor authentication is now on',
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${name},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        An authenticator app was just added to your ScopeGov account. From now on,
        signing in will require your password and a code from that app.
      </p>
      <p style="font-size:13px;color:${C.text2};">
        Didn't do this? Contact your workspace owner immediately and change your password.
      </p>
    `,
  })
  return resend.emails.send({ from: `ScopeGov <${FROM}>`, to, subject: 'Two-factor authentication enabled on your ScopeGov account', html })
}

// ── Security: MFA disabled ───────────────────────────────────
export async function sendMfaDisabledEmail(params: { to: string; name: string; via: 'user' | 'backup_code_recovery' }) {
  const { to, name, via } = params
  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.red,
    headerIcon: '🔓',
    label: 'Security',
    headline: 'Two-factor authentication was turned off',
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${name},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        ${via === 'backup_code_recovery'
          ? 'Two-factor authentication on your ScopeGov account was just removed using a backup recovery code. If your workspace requires MFA for your role, you will be asked to set it up again the next time you sign in.'
          : 'Two-factor authentication on your ScopeGov account was just turned off.'}
      </p>
      <p style="font-size:13px;color:${C.text2};">
        Didn't do this? Contact your workspace owner immediately and change your password.
      </p>
    `,
  })
  return resend.emails.send({ from: `ScopeGov <${FROM}>`, to, subject: 'Two-factor authentication was disabled on your ScopeGov account', html })
}

// ── Security: backup codes regenerated ───────────────────────
export async function sendMfaBackupCodesRegeneratedEmail(params: { to: string; name: string }) {
  const { to, name } = params
  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.amber,
    headerIcon: '🔐',
    label: 'Security',
    headline: 'New backup codes were generated',
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${name},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        A new set of two-factor backup codes was generated for your ScopeGov account.
        Your previous codes no longer work.
      </p>
      <p style="font-size:13px;color:${C.text2};">
        Didn't do this? Contact your workspace owner immediately and change your password.
      </p>
    `,
  })
  return resend.emails.send({ from: `ScopeGov <${FROM}>`, to, subject: 'New two-factor backup codes generated', html })
}

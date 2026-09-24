export const runtime = 'nodejs'

import { escapeHtml } from '@/lib/utils/sanitize'
import { sendEmail, type EmailPayload, type EmailLogContext, type SendResult } from '@/lib/email/send'
import { formatFrom, systemFrom } from '@/lib/email/from'
import { formatMoney } from '@/lib/utils/money'
const money = formatMoney

// FIX (Notifications & email fix round): the lazy Resend singleton, the FROM
// constant and BRAND_FROM that lived here moved to lib/email/{send,from}.ts.
// `emails.send()` never throws for an API failure, so every sender below now
// returns an explicit SendResult (via sendEmail) instead of handing the raw
// `{ data, error }` to callers that wrapped it in a try/catch that could not
// fire. lib/email/delivery.ts#checkedSend understands this result shape.
export type { SendResult, EmailLogContext }
const deliver = (payload: EmailPayload, log?: EmailLogContext): Promise<SendResult> => sendEmail(payload, log)

// FIX (deep audit round 2, notifications section — feature gap): the app has
// a full opt-out/lock system for these events (notification_preferences,
// workspace_notification_defaults, the Settings > Notifications tab), but
// not one of the ~20 internal-team notification emails ever linked back to
// it — a recipient who wanted to turn a given notification off had no way
// to discover that page from the email itself. Only relevant for internal
// team members (who have a ScopeGov login and a Settings page); client-
// facing emails (SOW/CO/invoice sends, reminders, cancellations) don't get
// this, since clients never have an account or a preferences page to visit.
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || ''

// FIX (audit round 4, finding #7): none of these templates HTML-escaped
// interpolated dynamic content — client/project/agency names, notes,
// descriptions, escalation text, and (most concerning) the AI-generated
// `reasoning` field from Guardian classification, which is downstream of
// unauthenticated inbound client email content (see app/api/guardian/
// inbound/route.ts). A crafted inbound email could get its content
// paraphrased into `reasoning` by the classifier and injected as raw
// markup into an internal notification email your own team reads and
// trusts. Applied below: every free-text field that reaches an HTML
// `body`/`headline`/`label` is escaped at the point it's read out of
// `params`; `subject` lines (plain text, not HTML) intentionally use the
// original unescaped value so an "&" in a project name doesn't show up
// as "&amp;" in someone's inbox subject line.
//
// Reuses lib/utils/sanitize.ts's escapeHtml — already the shared helper
// for this exact purpose (see app/api/portal/co/[token]/_actions.ts's
// ad-hoc emails), rather than a second copy living only in this file.


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
  // FIX (deep audit round 2, notifications section — feature gap): see the
  // comment on APP_URL above. Passed explicitly per-call (rather than
  // inferred from event type here) so it stays an opt-in per sender —
  // client-facing sends never set it.
  showPreferencesLink,
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
  showPreferencesLink?: boolean
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
        <!-- FIX (re-audit, notifications section): headerIcon was accepted
             and typed as a param, and four security-email senders each
             passed a distinct icon (🔐/🔓/🔑) specifically to visually
             differentiate MFA-enabled vs MFA-disabled vs password-changed
             at a glance — but it was never actually interpolated anywhere
             in this template. Every email using baseTemplate rendered an
             identical header regardless of what was passed; the
             differentiation those four senders were built for never shipped. -->
        <span style="font-size:15px;line-height:1;">${headerIcon}</span>
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
        ${agencyName && agencyName !== 'ScopeGov' ? `on behalf of ${agencyName} ` : ''}&middot; Scope governance for agencies
      </p>
      ${showPreferencesLink ? `
      <p style="font-size:11px;color:${C.text3};margin:6px 0 0;">
        <a href="${APP_URL}/settings?tab=notifications" style="color:${C.text3};text-decoration:underline;">Manage notification preferences</a>
      </p>
      ` : ''}
    </div>
  </div>
</body>
</html>`
}

// ── Event 1: SOW sent ─────────────────────────────────────────
export async function sendSowEmail(params: {
  replyTo?: string | null; log?: EmailLogContext
  to: string; cc?: string[]; clientName: string; agencyName: string
  projectName: string; contractValue: number; currency: string
  portalUrl: string; brandColour?: string; expiresAt: string
}) {
  const { to, cc, clientName: clientNameRaw, agencyName: agencyNameRaw, projectName: projectNameRaw, contractValue,
    currency, portalUrl, brandColour, expiresAt } = params
  const clientName  = escapeHtml(clientNameRaw)
  const agencyName  = escapeHtml(agencyNameRaw)
  const projectName = escapeHtml(projectNameRaw)

  const expiryDate = new Date(expiresAt).toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric', timeZone: 'UTC' })

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
          <span style="font-weight:600;color:${C.green};">${money(contractValue, currency)}</span>
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

  return deliver({
    from:    formatFrom(agencyNameRaw),
    replyTo: params.replyTo,
    to,
    cc:      cc?.filter(Boolean) || [],
    subject: `Action required: Review your ${projectNameRaw} SOW`,
    html,
  }, params.log)
}

// ── Event 3: SOW signed (agency notification) ─────────────────
export async function sendSowSignedAgencyEmail(params: {
  to: string[]; agencyName: string; clientName: string
  projectName: string; signedBy: string; portalUrl: string
  // FIX (Notifications & email fix round): this email announced the most
  // important event in the SOW lifecycle with no link back into the app
  // (portalUrl was accepted and never used).
  projectId?: string
  attachments?: Array<{ filename: string; content: string }>
}) {
  const { to, agencyName: agencyNameRaw, clientName: clientNameRaw, projectName: projectNameRaw, signedBy: signedByRaw, attachments, projectId } = params
  const agencyName  = escapeHtml(agencyNameRaw)
  const clientName  = escapeHtml(clientNameRaw)
  const projectName = escapeHtml(projectNameRaw)
  const signedBy    = escapeHtml(signedByRaw)

  const html = baseTemplate({
    agencyName,
    headerColour: C.green,
    label: 'Agreement signed',
    headline: `${clientName} has signed the SOW`,
    showPreferencesLink: true,
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
    ...(projectId ? { cta: 'Open project in ScopeGov', ctaUrl: `${process.env.NEXT_PUBLIC_APP_URL}/projects/${projectId}?tab=sow` } : {}),
  })

  return deliver({
    from:    systemFrom(),
    to,
    subject: `✓ ${clientNameRaw} signed the ${projectNameRaw} SOW`,
    html,
    ...(attachments?.length ? { attachments } : {}),
  })
}

// ── Event 4: SOW signed (client confirmation) ─────────────────
// FIX (SOW-lifecycle fix round): this was the one client-facing email in
// the whole SOW lifecycle with no `cc` support at all — the initial send
// (sendSowEmail), the reminder, and the cancellation notice all thread
// client.cc_emails through, but whoever was CC'd throughout the deal (a
// client's finance contact, manager, etc.) was silently dropped from the
// one email confirming the agreement is actually signed. Matches
// sendCoAcceptedClientEmail's shape on the CO side, which already had this.
export async function sendSowSignedClientEmail(params: {
  replyTo?: string | null; log?: EmailLogContext
  to: string; cc?: string[]; clientName: string; agencyName: string
  projectName: string; portalUrl: string
  attachments?: Array<{ filename: string; content: string }>
}) {
  const { to, cc, clientName: clientNameRaw, agencyName: agencyNameRaw, projectName: projectNameRaw, portalUrl, attachments } = params
  const clientName  = escapeHtml(clientNameRaw)
  const agencyName  = escapeHtml(agencyNameRaw)
  const projectName = escapeHtml(projectNameRaw)

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

  return deliver({
    from:    formatFrom(agencyNameRaw),
    replyTo: params.replyTo,
    to,
    cc:      cc?.filter(Boolean) || [],
    subject: `Your ${projectNameRaw} agreement is confirmed`,
    html,
    ...(attachments?.length ? { attachments } : {}),
  }, params.log)
}

// ── Event 5: SOW declined ─────────────────────────────────────
export async function sendSowDeclinedEmail(params: {
  to: string[]; agencyName: string; clientName: string
  projectName: string; reason?: string
  // Deep-links the CTA to the project's SOW tab instead of the bare projects list.
  projectId?: string
}) {
  const { to, agencyName: agencyNameRaw, clientName: clientNameRaw, projectName: projectNameRaw, reason: reasonRaw, projectId } = params
  const agencyName  = escapeHtml(agencyNameRaw)
  const clientName  = escapeHtml(clientNameRaw)
  const projectName = escapeHtml(projectNameRaw)
  const reason      = escapeHtml(reasonRaw)

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
    ctaUrl: projectId ? `${process.env.NEXT_PUBLIC_APP_URL}/projects/${projectId}?tab=sow` : `${process.env.NEXT_PUBLIC_APP_URL}/projects`,
    showPreferencesLink: true,
  })

  return deliver({
    from:    systemFrom(),
    to,
    subject: `Client declined the ${projectNameRaw} SOW`,
    html,
  })
}

// FIX (build, cron section): sow-stall used to be a pure status flip —
// no email, no in-app notification, just an audit-log row nobody would
// see unless they happened to check the dashboard. For a product whose
// whole premise is catching things before they go silently stale, a
// stalled SOW that tells no one was a real gap, not just a nice-to-have.
export async function sendSowStalledEmail(params: {
  to: string[]; clientName: string; projectName: string
  daysSinceSent: number; projectUrl: string
  /** e.g. "They have not opened it yet." / "They opened it on 3 Mar 2026." (from first_viewed_at) */
  viewedNote?: string
}) {
  const { to, clientName: clientNameRaw, projectName: projectNameRaw, daysSinceSent, projectUrl, viewedNote } = params
  const clientName  = escapeHtml(clientNameRaw)
  const projectName = escapeHtml(projectNameRaw)

  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.amber,
    label: 'SOW stalled',
    headline: `${clientName} hasn't signed — ${projectName}`,
    body: `
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        The Statement of Work for <strong>${projectName}</strong> has been awaiting <strong>${clientName}</strong>'s
        signature for over ${daysSinceSent} days with no response.${viewedNote ? ` <strong>${escapeHtml(viewedNote)}</strong>` : ''}
      </p>
      <p style="font-size:13px;color:${C.text2};margin:0;">
        Worth a follow-up — you can send a reminder or check in directly from the project page.
      </p>
    `,
    cta: 'Open project →',
    ctaUrl: projectUrl,
    showPreferencesLink: true,
  })

  return deliver({
    from:    systemFrom(),
    to,
    subject: `SOW stalled — ${projectNameRaw} awaiting signature ${daysSinceSent}+ days`,
    html,
  })
}

// FIX (deep audit, notifications section): 'sow_expired' has been in
// EVENT_TYPES since the 9-G3 fix above — rendered in Settings under
// "Email notifications," lockable by workspace admins via
// workspace_notification_defaults — but no email ever backed it. Only an
// in-app row was ever created (see cron/sow-expiry), so the toggle did
// nothing. This is that missing counterpart, mirroring sendSowStalledEmail.
export async function sendSowExpiredEmail(params: {
  to: string[]; clientName: string; projectName: string; projectUrl: string
}) {
  const { to, clientName: clientNameRaw, projectName: projectNameRaw, projectUrl } = params
  if (to.length === 0) return
  const clientName  = escapeHtml(clientNameRaw)
  const projectName = escapeHtml(projectNameRaw)

  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.amber,
    label: 'SOW link expired',
    headline: `Signing link expired — ${projectName}`,
    body: `
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        The Statement of Work signing link for <strong>${projectName}</strong>, sent to
        <strong>${clientName}</strong>, expired before it was signed.
      </p>
      <p style="font-size:13px;color:${C.text2};margin:0;">
        You'll need to resend the SOW from the project page to give ${clientName} a new link.
      </p>
    `,
    cta: 'Open project →',
    ctaUrl: projectUrl,
    showPreferencesLink: true,
  })

  return deliver({
    from:    systemFrom(),
    to,
    subject: `SOW signing link expired — ${projectNameRaw}`,
    html,
  })
}

// FIX (section-10 audit, feature gap — CO expiry): change_orders had no
// 'expired' status at all (unlike sow_documents, which has had one since
// migration 001) and no equivalent cron — a CO's signing JWT still dies
// cryptographically at 30 days regardless, but the DB status just sat at
// 'stalled' (or whatever co-stall last set it to) forever, with a dead,
// never-revoked token and no signal to the agency short of a blocked
// Remind attempt. Migration 044 + cron/co-expiry close that gap; this is
// the email counterpart, mirroring sendSowExpiredEmail exactly.
export async function sendCoExpiredEmail(params: {
  to: string[]; clientName: string; projectName: string; projectUrl: string
}) {
  const { to, clientName: clientNameRaw, projectName: projectNameRaw, projectUrl } = params
  if (to.length === 0) return
  const clientName  = escapeHtml(clientNameRaw)
  const projectName = escapeHtml(projectNameRaw)

  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.amber,
    label: 'Change order link expired',
    headline: `Signing link expired — ${projectName}`,
    body: `
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        The change order signing link for <strong>${projectName}</strong>, sent to
        <strong>${clientName}</strong>, expired before it was resolved.
      </p>
      <p style="font-size:13px;color:${C.text2};margin:0;">
        You'll need to revise and resend it from the project page to give ${clientName} a new link.
      </p>
    `,
    cta: 'Open project →',
    ctaUrl: projectUrl,
    showPreferencesLink: true,
  })

  return deliver({
    from:    systemFrom(),
    to,
    subject: `Change order link expired — ${projectNameRaw}`,
    html,
  })
}

// ── Event 18: Guardian flag raised ────────────────────────────
export async function sendGuardianFlagEmail(params: {
  to: string[]; projectName: string
  severity: string; description: string; sowReference: string
  projectUrl: string; path?: string
}) {
  // FIX (re-audit, notifications section): `agencyName` was accepted here
  // and destructured but never once referenced in the template body below
  // — this email is unconditionally branded "ScopeGov" (it's the
  // platform's own automated flag, not agency-branded correspondence),
  // so the param was dead weight in the signature. Dropped it and updated
  // both call sites (guardian/check, guardian/inbound) accordingly.
  const { to, projectName: projectNameRaw, severity, description: descriptionRaw, sowReference: sowReferenceRaw, projectUrl, path: pathRaw } = params
  const projectName   = escapeHtml(projectNameRaw)
  const description   = escapeHtml(descriptionRaw)
  const sowReference  = escapeHtml(sowReferenceRaw)
  const path          = escapeHtml(pathRaw)

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
    showPreferencesLink: true,
  })

  return deliver({
    from:    systemFrom('ScopeGov Guardian'),
    to,
    subject: `[${severity.toUpperCase()}] Scope flag on ${projectNameRaw}`,
    html,
  })
}

// ── Event 20: Invite sent ─────────────────────────────────────
export async function sendInviteEmail(params: {
  to: string; inviterName: string; workspaceName: string
  agencyName: string; inviteUrl: string; expiresAt: string; roleName?: string | null
}) {
  const { to, inviterName: inviterNameRaw, workspaceName: workspaceNameRaw, agencyName, inviteUrl, expiresAt, roleName: roleNameRaw } = params
  const inviterName   = escapeHtml(inviterNameRaw)
  const workspaceName = escapeHtml(workspaceNameRaw)
  const roleLine = roleNameRaw
    ? `<p style="font-size:13px;color:${C.text2};line-height:1.7;margin:0 0 16px;">You&apos;ll join as <strong>${escapeHtml(roleNameRaw)}</strong>.</p>`
    : ''

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
      ${roleLine}
      <p style="font-size:13px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        As a team member, you&apos;ll be able to collaborate on projects, SOWs, change orders,
        and Guardian scope monitoring.
      </p>
      <p style="font-size:12px;color:${C.text3};margin:0;">
        This invitation expires on ${new Date(expiresAt).toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric', timeZone: 'UTC' })}.
      </p>
    `,
    cta: 'Accept invitation →',
    ctaUrl: inviteUrl,
  })

  return deliver({
    from:    systemFrom(),
    to,
    subject: `${inviterNameRaw} invited you to join ${workspaceNameRaw} on ScopeGov`,
    html,
  })
}

// ── Event 26: Trial ending soon ───────────────────────────────
export async function sendTrialWarningEmail(params: {
  to: string; name: string; agencyName: string
  daysLeft: number; upgradeUrl: string
}) {
  const { to, name: nameRaw, agencyName: agencyNameRaw, daysLeft, upgradeUrl } = params
  const name       = escapeHtml(nameRaw)
  const agencyName = escapeHtml(agencyNameRaw)

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
    showPreferencesLink: true,
  })

  return deliver({
    from:    systemFrom(),
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
  const { to, assigneeName: assigneeNameRaw, agencyName, entityType, entityName: entityNameRaw, note: noteRaw, url } = params
  const assigneeName = escapeHtml(assigneeNameRaw)
  const entityName    = escapeHtml(entityNameRaw)
  const note           = escapeHtml(noteRaw)

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
    showPreferencesLink: true,
  })

  return deliver({
    from:    systemFrom(),
    to,
    subject: `Escalated to you: ${entityNameRaw}`,
    html,
  })
}

// ── Event: Approval requested (internal — notifies the current step's
//    approver(s) that a SOW/CO is waiting on them) ──────────────
export async function sendApprovalRequestedEmail(params: {
  to: string; approverName: string
  documentLabel: string; documentTitle: string; projectName: string
  amount: number; currency: string
  stepNumber: number; totalSteps: number
  requestedByName: string; url: string
  // FIX (section-11 audit, pass 2): the in-app notification already said
  // "accept the client's counter on …" for a counter-offer, but this email
  // always said "wants to send … before it can go to the client" — an
  // approver reading the email was told to authorize a different action than
  // the one they were about to approve.
  isCounter?: boolean
}) {
  const { to, approverName: approverNameRaw, documentLabel, documentTitle: documentTitleRaw, projectName: projectNameRaw,
    amount, currency, stepNumber, totalSteps, requestedByName: requestedByNameRaw, url, isCounter } = params
  const approverName    = escapeHtml(approverNameRaw)
  const documentTitle   = escapeHtml(documentTitleRaw)
  const projectName     = escapeHtml(projectNameRaw)
  const requestedByName = escapeHtml(requestedByNameRaw)

  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.gold,
    label: 'Approval Requested',
    headline: `${documentLabel} awaiting your approval`,
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${approverName},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        <strong>${requestedByName}</strong> wants to ${isCounter ? 'accept the client\'s counter-offer on' : 'send'} <strong>${documentTitle}</strong>
        on <strong>${projectName}</strong>, and it needs your sign-off
        ${totalSteps > 1 ? `(step ${stepNumber} of ${totalSteps})` : ''} before ${isCounter ? 'it can be accepted' : 'it can go to the client'}.
      </p>
      <div style="background:${C.goldLt};border-left:3px solid ${C.gold};padding:14px 16px;margin:16px 0;border-radius:0 6px 6px 0;">
        <div style="display:flex;justify-content:space-between;font-size:13px;">
          <span style="color:${C.text2};">${documentTitle}</span>
          <span style="font-weight:600;color:${C.gold};">${money(amount, currency)}</span>
        </div>
      </div>
    `,
    cta: 'Review & decide →',
    ctaUrl: url,
    showPreferencesLink: true,
  })

  return deliver({
    from:    systemFrom(),
    to,
    subject: `Approval needed: ${documentTitleRaw} — ${projectNameRaw}`,
    html,
  })
}

// ── Event: Approval decided (internal — notifies the requester once a
//    chain fully approves, is rejected at any step, or is cancelled) ────
export async function sendApprovalDecisionEmail(params: {
  to: string; requesterName: string
  decision: 'approved' | 'rejected'
  documentLabel: string; documentTitle: string; projectName: string
  decidedByName: string; note?: string; url: string
  autoSent?: boolean
  // FIX (section-11 fix round, flagship finding): see the matching fix in
  // lib/approvals/engine.ts (notifyRequester) — a failed auto-send used to
  // produce the exact same email as a successful one. sendFailedReason
  // being present means approved && !autoSent, i.e. the chain approved
  // but the mechanical send afterward failed.
  sendFailedReason?: string | null
  // FIX (section-11 audit, pass 2): the document was sent but the mail
  // provider rejected the email to the client — previously reported as a
  // plain success ("sent to client").
  deliveryWarning?: string | null
  isCounter?: boolean
}) {
  const { to, requesterName: requesterNameRaw, decision, documentLabel, documentTitle: documentTitleRaw,
    projectName: projectNameRaw, decidedByName: decidedByNameRaw, note: noteRaw, url, autoSent,
    sendFailedReason: sendFailedReasonRaw, deliveryWarning: deliveryWarningRaw, isCounter } = params
  const approved       = decision === 'approved'
  const sendFailed      = approved && !!sendFailedReasonRaw
  const requesterName  = escapeHtml(requesterNameRaw)
  const documentTitle  = escapeHtml(documentTitleRaw)
  const projectName    = escapeHtml(projectNameRaw)
  const decidedByName  = escapeHtml(decidedByNameRaw)
  const note           = escapeHtml(noteRaw)
  const sendFailedReason = escapeHtml(sendFailedReasonRaw)
  const deliveryWarning  = approved && !sendFailed ? escapeHtml(deliveryWarningRaw) : ''

  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: approved ? (sendFailed || deliveryWarning ? C.amber : C.green) : C.red,
    label: approved ? (sendFailed ? 'Approved — action needed' : 'Approval Granted') : 'Approval Rejected',
    headline: approved
      ? (sendFailed ? `${documentLabel} approved, but not sent` : `${documentLabel} approved${autoSent ? ' and sent' : ''}`)
      : `${documentLabel} was rejected`,
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${requesterName},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        ${decidedByName} ${approved ? 'approved' : 'rejected'} <strong>${documentTitle}</strong>
        on <strong>${projectName}</strong>.
        ${approved && autoSent ? ' It has been sent to the client automatically.' : ''}
        ${!approved ? (isCounter
          ? ' The counter-offer has not been accepted and is still open — review it and try again.'
          : ' It has not been sent and remains a draft — make any changes needed and resubmit.') : ''}
      </p>
      ${deliveryWarning ? `
      <div style="background:${C.amberLt || C.bg};border:1px solid ${C.amber};border-radius:6px;padding:14px 16px;margin:16px 0;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:${C.amber};margin-bottom:6px;">The client email did not go out</div>
        <p style="font-size:13px;color:${C.text};margin:0;">${deliveryWarning}</p>
      </div>
      ` : ''}
      ${sendFailed ? `
      <div style="background:${C.amberLt || C.bg};border:1px solid ${C.amber};border-radius:6px;padding:14px 16px;margin:16px 0;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:${C.amber};margin-bottom:6px;">It was not sent to the client</div>
        <p style="font-size:13px;color:${C.text};margin:0;">The approval went through, but sending it failed: ${sendFailedReason}. Open it in Approvals and retry once the issue is resolved — this will not require re-approval.</p>
      </div>
      ` : ''}
      ${note ? `
      <div style="background:${C.bg};border:1px solid ${C.border};border-radius:6px;padding:14px 16px;margin:16px 0;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:${C.text3};margin-bottom:6px;">Note from ${decidedByName}</div>
        <p style="font-size:13px;color:${C.text};margin:0;">${note}</p>
      </div>
      ` : ''}
    `,
    cta: 'View in ScopeGov →',
    ctaUrl: url,
    showPreferencesLink: true,
  })

  return deliver({
    from:    systemFrom(),
    to,
    subject: sendFailed
      ? `Action needed: ${documentTitleRaw} approved but not sent — ${projectNameRaw}`
      : `${approved ? 'Approved' : 'Rejected'}: ${documentTitleRaw} — ${projectNameRaw}`,
    html,
  })
}

// ── Event 9: CO sent ──────────────────────────────────────────
export async function sendCoEmail(params: {
  replyTo?: string | null; log?: EmailLogContext
  to: string; cc?: string[]; clientName: string; agencyName: string
  projectName: string; coTitle: string; total: number; currency: string
  portalUrl: string; brandColour?: string; note?: string
}) {
  const { to, cc, clientName: clientNameRaw, agencyName: agencyNameRaw, projectName: projectNameRaw, coTitle: coTitleRaw, total, currency,
    portalUrl, brandColour, note: noteRaw } = params
  const clientName  = escapeHtml(clientNameRaw)
  const agencyName  = escapeHtml(agencyNameRaw)
  const projectName = escapeHtml(projectNameRaw)
  const coTitle     = escapeHtml(coTitleRaw)
  const note        = escapeHtml(noteRaw)

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
          <span style="font-weight:600;color:${C.green};">${money(total, currency)}</span>
        </div>
      </div>
    `,
    cta: 'Review & respond to change order →',
    ctaUrl: portalUrl,
  })

  return deliver({
    from:    formatFrom(agencyNameRaw),
    replyTo: params.replyTo,
    to,
    cc:      cc?.filter(Boolean) || [],
    subject: `Change order: ${coTitleRaw} — ${projectNameRaw}`,
    html,
  }, params.log)
}

// FIX (build, cron section): co-stall's counterpart to sendSowStalledEmail
// above — same gap, same fix. A stalled CO used to be a pure status flip
// with zero outbound signal.
export async function sendCoStalledEmail(params: {
  to: string[]; clientName: string; projectName: string; coTitle: string
  daysSinceSent: number; projectUrl: string
  /** e.g. "They have not opened it yet." / "They opened it on 3 Mar 2026." (from first_viewed_at) */
  viewedNote?: string
}) {
  const { to, clientName: clientNameRaw, projectName: projectNameRaw, coTitle: coTitleRaw, daysSinceSent, projectUrl, viewedNote } = params
  const clientName  = escapeHtml(clientNameRaw)
  const projectName = escapeHtml(projectNameRaw)
  const coTitle     = escapeHtml(coTitleRaw)

  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.amber,
    label: 'Change order stalled',
    headline: `${clientName} hasn't responded — ${coTitle}`,
    body: `
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        The change order <strong>${coTitle}</strong> on <strong>${projectName}</strong> has been awaiting
        <strong>${clientName}</strong>'s response for over ${daysSinceSent} days with no reply.${viewedNote ? ` <strong>${escapeHtml(viewedNote)}</strong>` : ''}
      </p>
      <p style="font-size:13px;color:${C.text2};margin:0;">
        Worth a follow-up — you can send a reminder or escalate directly from the project page.
      </p>
    `,
    cta: 'Open project →',
    ctaUrl: projectUrl,
    showPreferencesLink: true,
  })

  return deliver({
    from:    systemFrom(),
    to,
    subject: `Change order stalled — ${coTitleRaw} awaiting response ${daysSinceSent}+ days`,
    html,
  })
}

// FIX (deep audit, notifications section): CO decline/counter agency
// notifications used to be hand-rolled Resend calls in
// app/api/portal/co/[token]/_actions.ts, bypassing baseTemplate entirely —
// the only two "notify the agency something happened on a CO" emails in
// the whole app that did this (SOW declined, SOW/CO stalled, CO accepted
// all go through the shared template above/below). Escaping was already
// correct there so there was no security issue, just an architectural and
// branding inconsistency — these two now match every sibling email.
export async function sendCoDeclinedEmail(params: {
  to: string[]; clientName: string; projectName: string
  coTitle: string; reason?: string | null; projectUrl: string
}) {
  const { to, clientName: clientNameRaw, projectName: projectNameRaw, coTitle: coTitleRaw, reason: reasonRaw, projectUrl } = params
  const clientName  = escapeHtml(clientNameRaw)
  const projectName = escapeHtml(projectNameRaw)
  const coTitle     = escapeHtml(coTitleRaw)
  const reason      = reasonRaw ? escapeHtml(reasonRaw) : ''

  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.red,
    label: 'Change order declined',
    headline: `${clientName} declined — ${coTitle}`,
    body: `
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        <strong>${clientName}</strong> has declined the change order <strong>${coTitle}</strong> on <strong>${projectName}</strong>.
      </p>
      ${reason ? `
      <div style="background:${C.redLt};border:1px solid #FECACA;border-radius:6px;padding:14px 16px;margin:16px 0;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:${C.red};margin-bottom:6px;">Reason given</div>
        <p style="font-size:13px;color:${C.text};margin:0;">${reason}</p>
      </div>
      ` : ''}
    `,
    cta: 'View in ScopeGov',
    ctaUrl: projectUrl,
    showPreferencesLink: true,
  })

  return deliver({
    from:    systemFrom(),
    to,
    subject: `${clientNameRaw} declined the change order — ${coTitleRaw}`,
    html,
  })
}

export async function sendCoCounteredEmail(params: {
  to: string[]; clientName: string; coTitle: string
  counterAmount: number; currency: string; counterNote?: string | null
  projectUrl: string
}) {
  const {
    to, clientName: clientNameRaw, coTitle: coTitleRaw,
    counterAmount, currency, counterNote: counterNoteRaw, projectUrl,
  } = params
  const clientName  = escapeHtml(clientNameRaw)
  const coTitle     = escapeHtml(coTitleRaw)
  const counterNote = counterNoteRaw ? escapeHtml(counterNoteRaw) : ''

  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.amber,
    label: 'Counter offer received',
    headline: `${clientName} proposed a counter offer`,
    body: `
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        <strong>${clientName}</strong> has proposed a counter offer of
        <strong>${money(counterAmount, currency || 'USD')}</strong> on <strong>${coTitle}</strong>.
      </p>
      ${counterNote ? `
      <div style="background:${C.amberLt};border:1px solid #FDE68A;border-radius:6px;padding:14px 16px;margin:16px 0;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:${C.amber};margin-bottom:6px;">Note from client</div>
        <p style="font-size:13px;color:${C.text};margin:0;">${counterNote}</p>
      </div>
      ` : ''}
      <p style="font-size:13px;color:${C.text2};margin:0;">
        Review the counter offer and respond in ScopeGov.
      </p>
    `,
    cta: 'Review counter in ScopeGov',
    ctaUrl: projectUrl,
    showPreferencesLink: true,
  })

  return deliver({
    from:    systemFrom(),
    to,
    subject: `Counter offer received — ${coTitleRaw}`,
    html,
  })
}

// ── Event 11: CO accepted (agency) ───────────────────────────
export async function sendCoAcceptedEmail(params: {
  // FIX (deep audit, notifications section): `agencyName` was accepted
  // here and dutifully passed by the caller (finalize-co.ts) but never
  // once referenced below — this email is unconditionally branded
  // "ScopeGov" (same reasoning as sendGuardianFlagEmail's identical dead
  // param, already dropped there). Dropped here too and at the call site.
  to: string[]; clientName: string
  projectName: string; coTitle: string; total: number
  currency: string; acceptedBy: string; projectUrl: string
  attachments?: Array<{ filename: string; content: string }>
}) {
  const { to, clientName: clientNameRaw, projectName: projectNameRaw, coTitle: coTitleRaw, total, currency, acceptedBy: acceptedByRaw, projectUrl, attachments } = params
  const clientName  = escapeHtml(clientNameRaw)
  const projectName = escapeHtml(projectNameRaw)
  const coTitle     = escapeHtml(coTitleRaw)
  const acceptedBy  = escapeHtml(acceptedByRaw)

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
          <strong style="color:${C.green};">${money(total, currency)}</strong>
        </div>
        <div style="font-size:12px;color:${C.text3};">Signed by: ${acceptedBy}</div>
      </div>
      <p style="font-size:13px;color:${C.text2};">
        An amendment has been created and the contract value updated automatically.
      </p>
    `,
    cta: 'View project →',
    ctaUrl: projectUrl,
    showPreferencesLink: true,
  })

  return deliver({
    from:    systemFrom(),
    to,
    subject: `✓ Change order accepted — ${projectNameRaw} +${money(total, currency)}`,
    html,
    ...(attachments?.length ? { attachments } : {}),
  })
}

// FIX (doc-completeness audit): sendCoAcceptedEmail (above) only ever
// notified the AGENCY. The client — who just agreed to additional scope
// and money — never received any confirmation or document at all. This
// is the client-facing counterpart, mirroring sendSowSignedClientEmail.
export async function sendCoAcceptedClientEmail(params: {
  replyTo?: string | null; log?: EmailLogContext
  to: string; cc?: string[]; clientName: string; agencyName: string
  projectName: string; coTitle: string; total: number; currency: string
  portalUrl: string
  attachments?: Array<{ filename: string; content: string }>
}) {
  const { to, cc, clientName: clientNameRaw, agencyName: agencyNameRaw, projectName: projectNameRaw,
    coTitle: coTitleRaw, total, currency, portalUrl, attachments } = params
  const clientName  = escapeHtml(clientNameRaw)
  const agencyName  = escapeHtml(agencyNameRaw)
  const projectName = escapeHtml(projectNameRaw)
  const coTitle     = escapeHtml(coTitleRaw)

  const html = baseTemplate({
    agencyName,
    headerColour: C.green,
    label: 'Change order confirmation',
    headline: 'Your change order is confirmed',
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${clientName},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        This confirms the change order <strong>${coTitle}</strong> for <strong>${projectName}</strong>
        with <strong>${agencyName}</strong>, for an additional <strong>${money(total, currency)}</strong>.
        A PDF copy is attached for your records.
      </p>
      <p style="font-size:13px;color:${C.text2};">
        If you have any questions, please contact ${agencyName} directly.
      </p>
    `,
    // FIX (portal audit, section 18 — closing pass): this CTA used to
    // read "Download PDF →" because ctaUrl pointed straight at the raw
    // /pdf endpoint (see finalize-co.ts's own fix note for why that
    // changed) — now that ctaUrl is the portal confirmation page, the
    // same wording the SOW-signed client email already uses for the
    // equivalent page-link CTA is the accurate label. The page itself
    // still offers a Download PDF button.
    cta: 'View your accepted change order',
    ctaUrl: portalUrl,
  })

  return deliver({
    from:    formatFrom(agencyNameRaw),
    replyTo: params.replyTo,
    to,
    cc:      cc?.filter(Boolean) || [],
    subject: `Your ${projectNameRaw} change order is confirmed`,
    html,
    ...(attachments?.length ? { attachments } : {}),
  }, params.log)
}

// FIX (doc-completeness audit): counter-accepted COs now need the client
// to countersign at the negotiated total before the CO is final (see
// migration 014) — this is the email carrying that new signing link.
export async function sendCoCountersignatureRequestEmail(params: {
  replyTo?: string | null; log?: EmailLogContext
  to: string; cc?: string[]; clientName: string; agencyName: string
  projectName: string; coTitle: string; total: number; currency: string
  portalUrl: string; brandColour?: string
}) {
  const { to, cc, clientName: clientNameRaw, agencyName: agencyNameRaw, projectName: projectNameRaw,
    coTitle: coTitleRaw, total, currency, portalUrl, brandColour } = params
  const clientName  = escapeHtml(clientNameRaw)
  const agencyName  = escapeHtml(agencyNameRaw)
  const projectName = escapeHtml(projectNameRaw)
  const coTitle     = escapeHtml(coTitleRaw)

  const html = baseTemplate({
    agencyName,
    headerColour: C.amber,
    label: 'Signature needed',
    headline: 'Please confirm your change order',
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${clientName},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        <strong>${agencyName}</strong> has accepted your proposed amount for
        <strong>${coTitle}</strong> on <strong>${projectName}</strong> —
        <strong>${money(total, currency)}</strong>. To finalize it,
        please review and sign to confirm.
      </p>
    `,
    cta: 'Review and sign →',
    ctaUrl: portalUrl,
  })

  return deliver({
    from:    formatFrom(agencyNameRaw),
    replyTo: params.replyTo,
    to,
    cc:      cc?.filter(Boolean) || [],
    subject: `Please confirm: ${coTitleRaw} — ${projectNameRaw}`,
    html,
  }, params.log)
}

// ── Payment failed / grace period ────────────────────────────
export async function sendPaymentFailedEmail(params: {
  to: string; name: string; agencyName: string
  upgradeUrl: string; graceDaysLeft: number
}) {
  const { to, name: nameRaw, agencyName: agencyNameRaw, upgradeUrl, graceDaysLeft } = params
  const name       = escapeHtml(nameRaw)
  const agencyName = escapeHtml(agencyNameRaw)

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

  return deliver({
    from:    systemFrom(),
    to,
    subject: `Action needed: Payment failed for ScopeGov — ${graceDaysLeft} days to resolve`,
    html,
  })
}

// FIX (build, cron section): companion to sendPaymentFailedEmail — that
// one covers "we tried to charge you and it failed", this covers "you
// cancelled, and your paid period has now genuinely ended" (see the
// cancelled-subscription enforcement step in cron/payment-overdue). Same
// downgrade outcome, deliberately calmer tone — this isn't a payment
// problem, it's an expected transition the person asked for.
export async function sendSubscriptionEndedEmail(params: {
  to: string; name: string; agencyName: string; upgradeUrl: string
}) {
  const { to, name: nameRaw, agencyName: agencyNameRaw, upgradeUrl } = params
  const name       = escapeHtml(nameRaw)
  const agencyName = escapeHtml(agencyNameRaw)

  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.text3,
    label: 'Subscription ended',
    headline: 'Your ScopeGov subscription has ended',
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${name},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        As requested, <strong>${agencyName}</strong>&apos;s paid subscription period has now ended and
        your workspace has moved to the Solo plan.
      </p>
      <p style="font-size:13px;color:${C.text2};">
        Your data hasn't gone anywhere — resubscribe any time to get your full plan's limits back.
      </p>
    `,
    cta: 'Resubscribe →',
    ctaUrl: upgradeUrl,
  })

  return deliver({
    from:    systemFrom(),
    to,
    subject: `Your ScopeGov subscription has ended — ${agencyNameRaw} moved to Solo`,
    html,
  })
}

// ── Phase 4a: Invoice sent (client-facing) ──────────────────────
// ── Document cancelled / voided / withdrawn (client-facing) ──────
// FIX (doc-completeness audit): none of these existed. Voiding an invoice
// or withdrawing a SOW/CO revoked the client's portal link server-side,
// but the client — who may already have the original "here's what you
// owe" or "please sign this" email sitting in their inbox — was never
// told anything changed. A client acting on the stale email (e.g. paying
// a voided invoice per its bank details) had nothing in-product warning
// them. One shared template covers all three document types.
export async function sendDocumentCancelledEmail(params: {
  replyTo?: string | null; log?: EmailLogContext
  to: string; cc?: string[]; clientName: string; agencyName: string
  projectName: string; documentLabel: string; documentTitle: string
  // FIX (CO-logic fix round): added 'closed' — see the call site in
  // api/co/[id]/close/route.ts for why. Before this, the only two options
  // both collapsed to 'withdrawn' wording (see the old verb ternary),
  // which would have told the client the agency "withdrew" a change order
  // it had actually closed out after a counter-offer, misstating what
  // happened.
  action: 'voided' | 'withdrawn' | 'closed'; reason?: string | null; brandColour?: string
}) {
  const { to, cc, clientName: clientNameRaw, agencyName: agencyNameRaw, projectName: projectNameRaw,
    documentLabel, documentTitle: documentTitleRaw, action, reason: reasonRaw, brandColour } = params
  const clientName    = escapeHtml(clientNameRaw)
  const agencyName    = escapeHtml(agencyNameRaw)
  const projectName   = escapeHtml(projectNameRaw)
  const documentTitle = escapeHtml(documentTitleRaw)
  const reason        = reasonRaw ? escapeHtml(reasonRaw) : null
  const verb = action === 'voided' ? 'voided' : action === 'closed' ? 'closed' : 'withdrawn'

  const html = baseTemplate({
    agencyName,
    headerColour: C.amber,
    label: `${documentLabel} ${verb}`,
    headline: `${documentTitle} has been ${verb}`,
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${clientName},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        <strong>${agencyName}</strong> has ${verb} the ${documentLabel.toLowerCase()}
        <strong>${documentTitle}</strong> on <strong>${projectName}</strong>. Any earlier link or copy
        you have for it is no longer active${action === 'voided' ? ' — please disregard it, including any amount or payment details it referenced' : ''}.
      </p>
      ${reason ? `<p style="font-size:13px;color:${C.text2};"><strong>Note from ${agencyName}:</strong> ${reason}</p>` : ''}
      <p style="font-size:13px;color:${C.text2};">If you have questions, please reach out to ${agencyName} directly.</p>
    `,
  })

  return deliver({
    from:    formatFrom(agencyNameRaw),
    replyTo: params.replyTo,
    to,
    cc:      cc?.filter(Boolean) || [],
    subject: `${documentLabel} ${verb}: ${documentTitleRaw} — ${projectNameRaw}`,
    html,
  }, params.log)
}

/**
 * Confirmation to the CLIENT that their response to a document (decline, change request, counter)
 * was received. Until now the client got nothing back after pressing those buttons.
 */
export async function sendClientResponseReceivedEmail(params: {
  replyTo?: string | null; log?: EmailLogContext
  to: string; cc?: string[]; clientName: string; agencyName: string; projectName: string
  documentLabel: string
  response: 'declined' | 'requested changes to' | 'countered' | 'disputed'
  note?: string | null; brandColour?: string
}) {
  const { to, cc, clientName: clientNameRaw, agencyName: agencyNameRaw, projectName: projectNameRaw,
    documentLabel, response, note: noteRaw, brandColour } = params
  const clientName  = escapeHtml(clientNameRaw)
  const agencyName  = escapeHtml(agencyNameRaw)
  const projectName = escapeHtml(projectNameRaw)
  const note        = noteRaw ? escapeHtml(noteRaw) : null

  const html = baseTemplate({
    agencyName,
    headerColour: brandColour || C.green,
    label: 'Response received',
    headline: `We\u2019ve recorded your response`,
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${clientName},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        This confirms that you ${response} the ${documentLabel.toLowerCase()} for
        <strong>${projectName}</strong>, and <strong>${agencyName}</strong> has been notified.
        They will follow up with you directly.
      </p>
      ${note ? `<p style="font-size:13px;color:${C.text2};"><strong>What you sent:</strong> ${note}</p>` : ''}
      <p style="font-size:12px;color:${C.text3};">If this wasn\u2019t you, please contact ${agencyName} right away.</p>
    `,
  })

  return deliver({
    from:    formatFrom(agencyNameRaw),
    replyTo: params.replyTo,
    to,
    cc:      cc?.filter(Boolean) || [],
    subject: `We received your response — ${projectNameRaw}`,
    html,
  }, params.log)
}

export async function sendInvoiceEmail(params: {
  replyTo?: string | null; log?: EmailLogContext
  to: string; cc?: string[]; clientName: string; agencyName: string
  projectName: string; invoiceNumber?: string | null; title: string
  amount: number; currency: string; dueDate?: string | null
  portalUrl: string; brandColour?: string; paymentInstructions?: string | null
  // FIX (doc-completeness audit, finding #4): this email used to be
  // link-only — no way to attach the invoice PDF, unlike the SOW/CO
  // signed-confirmation emails. Many AP/procurement workflows expect an
  // actual attached PDF to file the invoice against; optional so a
  // failed PDF build (see the send route) still lets the email go out.
  attachments?: Array<{ filename: string; content: string }>
}) {
  const { to, cc, clientName: clientNameRaw, agencyName: agencyNameRaw, projectName: projectNameRaw, invoiceNumber, title: titleRaw,
    amount, currency, dueDate, portalUrl, brandColour, paymentInstructions: paymentInstructionsRaw, attachments } = params
  const clientName           = escapeHtml(clientNameRaw)
  const agencyName           = escapeHtml(agencyNameRaw)
  const projectName          = escapeHtml(projectNameRaw)
  const title                = escapeHtml(titleRaw)
  const paymentInstructions  = escapeHtml(paymentInstructionsRaw)

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
          <span style="font-weight:600;color:${C.green};">${money(amount, currency)}</span>
        </div>
        ${dueDate ? `<div style="font-size:12px;color:${C.text3};margin-top:6px;">Due ${new Date(dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}</div>` : ''}
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

  return deliver({
    from:    formatFrom(agencyNameRaw),
    replyTo: params.replyTo,
    to,
    cc:      cc?.filter(Boolean) || [],
    subject: `Invoice${invoiceNumber ? ` ${invoiceNumber}` : ''}: ${titleRaw} — ${projectNameRaw}`,
    html,
    ...(attachments?.length ? { attachments } : {}),
  }, params.log)
}

// ── Phase 4a: Invoice reminder (client-facing) ───────────────────
export async function sendInvoiceReminderEmail(params: {
  replyTo?: string | null; log?: EmailLogContext
  to: string; cc?: string[]; clientName: string; agencyName: string
  projectName: string; invoiceNumber?: string | null; title: string
  balanceDue: number; currency: string; dueDate?: string | null
  portalUrl: string; brandColour?: string; isOverdue?: boolean
  paymentInstructions?: string | null
}) {
  const { to, cc, clientName: clientNameRaw, agencyName: agencyNameRaw, projectName: projectNameRaw, invoiceNumber, title: titleRaw,
    balanceDue, currency, dueDate, portalUrl, brandColour, isOverdue, paymentInstructions: paymentInstructionsRaw } = params
  const clientName  = escapeHtml(clientNameRaw)
  const agencyName  = escapeHtml(agencyNameRaw)
  const projectName = escapeHtml(projectNameRaw)
  const title       = escapeHtml(titleRaw)
  const paymentInstructions = escapeHtml(paymentInstructionsRaw)

  const html = baseTemplate({
    agencyName,
    headerColour: isOverdue ? C.amber : (brandColour || C.green),
    label: 'Payment reminder',
    headline: isOverdue ? `Overdue: ${title}` : `Reminder: ${title}`,
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${clientName},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        A friendly reminder that <strong>${money(balanceDue, currency)}</strong> is
        ${isOverdue ? 'now overdue' : 'outstanding'} on invoice${invoiceNumber ? ` ${invoiceNumber}` : ''} for
        <strong>${projectName}</strong>.
        ${dueDate ? ` Due date was ${new Date(dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}.` : ''}
      </p>
      ${paymentInstructions ? `
      <div style="background:${C.bg};border:1px solid ${C.border};border-radius:6px;padding:14px 16px;margin:16px 0;">
        <p style="font-size:11px;color:${C.text3};text-transform:uppercase;letter-spacing:.05em;margin:0 0 6px;">Payment instructions</p>
        <p style="font-size:13px;color:${C.text2};margin:0;line-height:1.6;white-space:pre-line;">${paymentInstructions}</p>
      </div>
      ` : ''}
    `,
    cta: 'View invoice →',
    ctaUrl: portalUrl,
  })

  return deliver({
    from:    formatFrom(agencyNameRaw),
    replyTo: params.replyTo,
    to,
    cc:      cc?.filter(Boolean) || [],
    subject: `${isOverdue ? 'Overdue' : 'Reminder'}: Invoice${invoiceNumber ? ` ${invoiceNumber}` : ''} — ${projectNameRaw}`,
    html,
  }, params.log)
}

// ── Phase 4a: Payment recorded (internal, agency-facing) ─────────
export async function sendInvoicePaymentRecordedEmail(params: {
  to: string[]; agencyName: string; clientName: string; projectName: string
  invoiceNumber?: string | null; amount: number; currency: string
  isFullyPaid: boolean; balanceRemaining: number; projectUrl: string
}) {
  const { to, clientName: clientNameRaw, projectName: projectNameRaw, invoiceNumber, amount, currency,
    isFullyPaid, balanceRemaining, projectUrl } = params
  if (to.length === 0) return
  const clientName  = escapeHtml(clientNameRaw)
  const projectName = escapeHtml(projectNameRaw)

  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.green,
    label: 'Payment recorded',
    headline: isFullyPaid ? `Invoice${invoiceNumber ? ` ${invoiceNumber}` : ''} paid in full` : `Payment received`,
    body: `
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        A payment of <strong>${money(amount, currency)}</strong> from <strong>${clientName}</strong>
        was recorded on <strong>${projectName}</strong>.
      </p>
      ${!isFullyPaid ? `<p style="font-size:13px;color:${C.text2};">Remaining balance: <strong>${money(balanceRemaining, currency)}</strong></p>` : ''}
    `,
    cta: 'View project →',
    ctaUrl: projectUrl,
    showPreferencesLink: true,
  })

  return deliver({
    from:    systemFrom(),
    to,
    subject: isFullyPaid
      ? `✓ Invoice paid in full — ${projectNameRaw} (${money(amount, currency)})`
      : `Payment received — ${projectNameRaw} (${money(amount, currency)})`,
    html,
  })
}

// FIX (deep audit, notifications section): migration 004 seeded
// 'invoice_sent' into workspace_notification_defaults alongside
// 'invoice_payment_received' and 'invoice_overdue' as one family of three —
// those two got a notify call, this template, a Settings toggle, and an
// admin lock; 'invoice_sent' got none of it. Sending an invoice notified
// the client only. This is the missing internal counterpart, mirroring
// sendInvoicePaymentRecordedEmail immediately below.
export async function sendInvoiceSentInternalEmail(params: {
  to: string[]; clientName: string; projectName: string
  invoiceNumber?: string | null; amount: number; currency: string; projectUrl: string
}) {
  const { to, clientName: clientNameRaw, projectName: projectNameRaw, invoiceNumber, amount, currency, projectUrl } = params
  if (to.length === 0) return
  const clientName  = escapeHtml(clientNameRaw)
  const projectName = escapeHtml(projectNameRaw)

  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.green,
    label: 'Invoice sent',
    headline: `Invoice${invoiceNumber ? ` ${invoiceNumber}` : ''} sent to ${clientName}`,
    body: `
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        An invoice for <strong>${money(amount, currency)}</strong> was sent to
        <strong>${clientName}</strong> on <strong>${projectName}</strong>.
      </p>
    `,
    cta: 'View project →',
    ctaUrl: projectUrl,
    showPreferencesLink: true,
  })

  return deliver({
    from:    systemFrom(),
    to,
    subject: `Invoice sent — ${projectNameRaw} (${money(amount, currency)})`,
    html,
  })
}

// ── Phase 4a: Invoice overdue (internal, agency-facing) ──────────
export async function sendInvoiceOverdueInternalEmail(params: {
  to: string[]; clientName: string; projectName: string
  invoiceNumber?: string | null; balanceDue: number; currency: string; projectUrl: string
}) {
  const { to, clientName: clientNameRaw, projectName: projectNameRaw, invoiceNumber, balanceDue, currency, projectUrl } = params
  if (to.length === 0) return
  const clientName  = escapeHtml(clientNameRaw)
  const projectName = escapeHtml(projectNameRaw)

  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.amber,
    label: 'Invoice overdue',
    headline: `${clientName} has an overdue invoice`,
    body: `
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        Invoice${invoiceNumber ? ` ${invoiceNumber}` : ''} on <strong>${projectName}</strong> passed its due date
        with <strong>${money(balanceDue, currency)}</strong> still outstanding.
      </p>
    `,
    cta: 'View project →',
    ctaUrl: projectUrl,
    showPreferencesLink: true,
  })

  return deliver({
    from:    systemFrom(),
    to,
    subject: `Overdue: ${clientNameRaw} — ${money(balanceDue, currency)} (${projectNameRaw})`,
    html,
  })
}

// FEATURE (cron audit, section 17): payment_milestones going overdue had
// no email counterpart at all — invoices going overdue (immediately
// above) get one; a milestone (the earlier stage, before it's even been
// invoiced) silently flipped status with nothing but a passive dashboard
// change. Mirrors sendInvoiceOverdueInternalEmail's shape.
export async function sendPaymentMilestoneOverdueEmail(params: {
  to: string[]; clientName: string; projectName: string
  milestoneTitle: string; amount: number; currency: string; projectUrl: string
}) {
  const { to, clientName: clientNameRaw, projectName: projectNameRaw, milestoneTitle: milestoneTitleRaw, amount, currency, projectUrl } = params
  if (to.length === 0) return
  const clientName     = escapeHtml(clientNameRaw)
  const projectName    = escapeHtml(projectNameRaw)
  const milestoneTitle = escapeHtml(milestoneTitleRaw)

  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.amber,
    label: 'Milestone overdue',
    headline: `Payment milestone overdue — ${projectName}`,
    body: `
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        <strong>${milestoneTitle}</strong> on <strong>${projectName}</strong> (${clientName}) passed its due date
        with <strong>${money(Number(amount), currency)}</strong> still pending.
      </p>
      <p style="font-size:13px;color:${C.text2};margin:0;">
        You may want to invoice it now, or follow up with the client directly.
      </p>
    `,
    cta: 'View project →',
    ctaUrl: projectUrl,
    showPreferencesLink: true,
  })

  return deliver({
    from:    systemFrom(),
    to,
    subject: `Milestone overdue — ${milestoneTitleRaw} (${projectNameRaw})`,
    html,
  })
}

// FEATURE (cron audit, section 17): a retainer's monthly milestones just
// stopped generating once its term ran out, with nothing telling the team
// the contract had ended — the same "let something go silently stale" gap
// this product's own stall crons exist to close elsewhere.
export async function sendRetainerEndingEmail(params: {
  to: string[]; clientName: string; projectName: string
  durationMonths: number; projectUrl: string
}) {
  const { to, clientName: clientNameRaw, projectName: projectNameRaw, durationMonths, projectUrl } = params
  if (to.length === 0) return
  const clientName  = escapeHtml(clientNameRaw)
  const projectName = escapeHtml(projectNameRaw)

  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.amber,
    label: 'Retainer ended',
    headline: `Retainer term ended — ${projectName}`,
    body: `
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        The ${durationMonths}-month retainer for <strong>${clientName}</strong> on
        <strong>${projectName}</strong> has run its course. No further monthly billing
        milestones will be generated automatically.
      </p>
      <p style="font-size:13px;color:${C.text2};margin:0;">
        If the engagement is continuing, set up a renewal or a new SOW from the project page.
      </p>
    `,
    cta: 'Open project →',
    ctaUrl: projectUrl,
    showPreferencesLink: true,
  })

  return deliver({
    from:    systemFrom(),
    to,
    subject: `Retainer ended — ${projectNameRaw}`,
    html,
  })
}

// FEATURE (cron audit, section 17 — flagship finding): guardian_flags had
// no stall reminder at all, unlike approval/co/sow, despite being the
// product's own core primitive. This is that reminder's email
// counterpart, mirroring sendCoStalledEmail/sendSowStalledEmail.
// FIX (deep audit, section 13): borderline_review flags previously had no
// automated stall reminder at all (see cron/guardian-flag-stall's own
// comment). Extending that cron to cover them meant this template started
// receiving flags whose status isn't actually 'open' and whose severity is
// the 'info' placeholder, not high/medium/low — the hardcoded "Open flag"
// headline and the "Resolve it, convert it to a change order, or log an
// exception" close-out line were both wrong for that case (a
// borderline_review flag can only be confirmed-out-of-scope, dismissed, or
// escalated — see guardian/flags/[id]'s status guards; none of resolve/
// draft_co/exception are reachable from that status). isBorderline
// switches both to the copy that actually matches what the reader can do.
export async function sendGuardianFlagStalledEmail(params: {
  to: string[]; projectName: string; clientName: string
  severity: string; description: string; daysOpen: number; projectUrl: string
  isBorderline?: boolean
}) {
  const { to, projectName: projectNameRaw, clientName: clientNameRaw, severity, description: descriptionRaw, daysOpen, projectUrl, isBorderline = false } = params
  if (to.length === 0) return
  const projectName = escapeHtml(projectNameRaw)
  const clientName  = escapeHtml(clientNameRaw)
  const description = escapeHtml(descriptionRaw)
  const severityLabel = isBorderline ? 'borderline' : severity

  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.amber,
    label: isBorderline ? 'Borderline item stalled' : 'Scope flag stalled',
    headline: isBorderline
      ? `Borderline item needs review — ${projectName}`
      : `Open flag needs attention — ${projectName}`,
    body: `
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        A <strong>${severityLabel}</strong>${isBorderline ? '' : '-severity'} scope ${isBorderline ? 'item' : 'flag'} on <strong>${projectName}</strong>
        (${clientName}) has ${isBorderline ? 'been awaiting review' : 'been open'} for ${daysOpen}+ days with no action.
      </p>
      <div style="background:${C.bg};border:1px solid ${C.border};border-radius:6px;padding:14px 16px;margin:16px 0;">
        <p style="font-size:13px;color:${C.text2};margin:0;line-height:1.6;">${description}</p>
      </div>
      <p style="font-size:13px;color:${C.text2};margin:0;">
        ${isBorderline
          ? 'Confirm it as out of scope or dismiss it from the project\'s Guardian tab.'
          : 'Resolve it, convert it to a change order, or log an exception from the project\'s Guardian tab.'}
      </p>
    `,
    cta: isBorderline ? 'Review item →' : 'Review flag →',
    ctaUrl: projectUrl,
    showPreferencesLink: true,
  })

  return deliver({
    from:    systemFrom(),
    to,
    subject: isBorderline
      ? `Borderline item awaiting review ${daysOpen}+ days — ${projectNameRaw}`
      : `Scope flag stalled ${daysOpen}+ days — ${projectNameRaw}`,
    html,
  })
}

// FEATURE (portal audit, section 18): the invoice portal had no way for a
// client to push back on an invoice at all — SOW gets decline +
// request-changes, CO gets decline + counter, invoice got nothing. This
// is the internal notification for the new client-facing dispute action
// (see app/api/portal/invoice/[token]/dispute).
export async function sendInvoiceDisputedEmail(params: {
  to: string[]; clientName: string; projectName: string
  invoiceNumber?: string | null; note: string; projectUrl: string
}) {
  const { to, clientName: clientNameRaw, projectName: projectNameRaw, invoiceNumber, note: noteRaw, projectUrl } = params
  if (to.length === 0) return
  const clientName  = escapeHtml(clientNameRaw)
  const projectName = escapeHtml(projectNameRaw)
  const note        = escapeHtml(noteRaw)

  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.red,
    label: 'Invoice disputed',
    headline: `${clientName} has a question about an invoice`,
    body: `
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        <strong>${clientName}</strong> flagged invoice${invoiceNumber ? ` ${invoiceNumber}` : ''} on
        <strong>${projectName}</strong> from the client portal.
      </p>
      <div style="background:${C.bg};border:1px solid ${C.border};border-radius:6px;padding:14px 16px;margin:16px 0;">
        <p style="font-size:13px;color:${C.text2};margin:0;line-height:1.6;">${note}</p>
      </div>
    `,
    cta: 'View invoice →',
    ctaUrl: projectUrl,
    showPreferencesLink: true,
  })

  return deliver({
    from:    systemFrom(),
    to,
    subject: `Invoice question from ${clientNameRaw} — ${projectNameRaw}`,
    html,
  })
}

// ── Billing: cancellation scheduled / resumed / card expiring ────────────
// FEATURE (Billing re-pass #3): cancelling or resuming a subscription — an
// action with real money consequences — sent no confirmation to anyone, and
// the other billing admins never learned it had happened.
export async function sendSubscriptionCancelScheduledEmail(params: {
  to: string; name: string; agencyName: string; endsAtLabel: string; actorName: string; manageUrl: string
}) {
  const { to, name: nameRaw, agencyName: agencyNameRaw, endsAtLabel: endsRaw, actorName: actorRaw, manageUrl } = params
  const name = escapeHtml(nameRaw), agencyName = escapeHtml(agencyNameRaw)
  const endsAtLabel = escapeHtml(endsRaw), actorName = escapeHtml(actorRaw)
  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.text3,
    label: 'Cancellation scheduled',
    headline: 'Your ScopeGov subscription is set to end',
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${name},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        ${actorName} cancelled the paid subscription for <strong>${agencyName}</strong>. You keep your
        current plan until <strong>${endsAtLabel}</strong>; after that the workspace moves to the Solo plan.
        You won&apos;t be charged again.
      </p>
      <p style="font-size:13px;color:${C.text2};">
        Changed your mind? You can resume the subscription any time before then and nothing changes.
      </p>
    `,
    cta: 'Manage subscription →',
    ctaUrl: manageUrl,
  })
  return deliver({
    from: systemFrom(), to,
    subject: `Subscription cancellation scheduled — ${agencyNameRaw}`,
    html,
  })
}

export async function sendSubscriptionResumedEmail(params: {
  to: string; name: string; agencyName: string; actorName: string; manageUrl: string
}) {
  const { to, name: nameRaw, agencyName: agencyNameRaw, actorName: actorRaw, manageUrl } = params
  const name = escapeHtml(nameRaw), agencyName = escapeHtml(agencyNameRaw), actorName = escapeHtml(actorRaw)
  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.green,
    label: 'Subscription resumed',
    headline: 'Your ScopeGov subscription will keep renewing',
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${name},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        ${actorName} resumed the subscription for <strong>${agencyName}</strong>. The scheduled
        cancellation has been removed and your plan will renew as normal.
      </p>
    `,
    cta: 'View billing →',
    ctaUrl: manageUrl,
  })
  return deliver({
    from: systemFrom(), to,
    subject: `Subscription resumed — ${agencyNameRaw}`,
    html,
  })
}

export async function sendCardExpiringEmail(params: {
  to: string; name: string; agencyName: string; cardLabel: string; expiryLabel: string; manageUrl: string
}) {
  const { to, name: nameRaw, agencyName: agencyNameRaw, cardLabel: cardRaw, expiryLabel: expRaw, manageUrl } = params
  const name = escapeHtml(nameRaw), agencyName = escapeHtml(agencyNameRaw)
  const cardLabel = escapeHtml(cardRaw), expiryLabel = escapeHtml(expRaw)
  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.amber,
    label: 'Card expiring',
    headline: 'The card on your subscription is about to expire',
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${name},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        The card used for <strong>${agencyName}</strong>&apos;s ScopeGov subscription (${cardLabel})
        expires <strong>${expiryLabel}</strong>. Update your payment details before then so the next
        renewal doesn&apos;t fail.
      </p>
    `,
    cta: 'Update payment details →',
    ctaUrl: manageUrl,
  })
  return deliver({
    from: systemFrom(), to,
    subject: `Your card is expiring — ${agencyNameRaw} subscription`,
    html,
  })
}

// ── Security: MFA enabled ────────────────────────────────────
// (audit round 6: this file previously also gained a sendOpsAlertEmail
// here for the guardian-health cron's alerting gap — a parallel session
// fixed that same gap independently, inline in the cron route itself
// using its own Resend client, before this reached the repo. Dropped the
// duplicate here rather than ship two different ways to send the same
// alert.)

export async function sendMfaEnabledEmail(params: { to: string; name: string }) {
  const { to, name: nameRaw } = params
  const name = escapeHtml(nameRaw)
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
  return deliver({ from: systemFrom(), to, subject: 'Two-factor authentication enabled on your ScopeGov account', html })
}

// ── Security: MFA disabled ───────────────────────────────────
export async function sendMfaDisabledEmail(params: { to: string; name: string; via: 'user' | 'backup_code_recovery' | 'admin_reset' }) {
  const { to, name: nameRaw, via } = params
  const name = escapeHtml(nameRaw)
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
          : via === 'admin_reset'
          ? 'A workspace administrator just reset two-factor authentication on your ScopeGov account, most likely because you were locked out. If your workspace requires MFA for your role, you will be asked to set it up again the next time you sign in.'
          : 'Two-factor authentication on your ScopeGov account was just turned off.'}
      </p>
      <p style="font-size:13px;color:${C.text2};">
        ${via === 'admin_reset'
          ? 'Didn\u2019t expect this? Check with your workspace administrator to confirm it was them.'
          : 'Didn\u2019t do this? Contact your workspace owner immediately and change your password.'}
      </p>
    `,
  })
  return deliver({ from: systemFrom(), to, subject: 'Two-factor authentication was disabled on your ScopeGov account', html })
}

// ── Security: backup codes regenerated ───────────────────────
export async function sendMfaBackupCodesRegeneratedEmail(params: { to: string; name: string }) {
  const { to, name: nameRaw } = params
  const name = escapeHtml(nameRaw)
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
  return deliver({ from: systemFrom(), to, subject: 'New two-factor backup codes generated', html })
}

// ── Security: password changed ───────────────────────────────
// FIX (deep audit, Auth+MFA section): every other sensitive account
// action (MFA enroll, MFA disable, backup-code regen, MFA recovery)
// sends a confirmation email — password change, the single most
// account-takeover-relevant action of all of them, sent none. Added
// here and wired into both password-change surfaces: the authenticated
// Settings flow (api/auth/change-password) and the recovery-link flow
// (/reset-password), via api/auth/password-changed.
export async function sendPasswordChangedEmail(params: { to: string; name: string; via: 'settings' | 'reset_link' }) {
  const { to, name: nameRaw, via } = params
  const name = escapeHtml(nameRaw)
  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.red,
    headerIcon: '🔑',
    label: 'Security',
    headline: 'Your password was changed',
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${name},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        ${via === 'reset_link'
          ? 'The password on your ScopeGov account was just reset using a password reset link, and every other session has been signed out.'
          : 'The password on your ScopeGov account was just changed from your account settings.'}
      </p>
      <p style="font-size:13px;color:${C.text2};">
        Didn't do this? Contact your workspace owner immediately${via === 'reset_link' ? '' : ' and reset your password'}.
      </p>
    `,
  })
  return deliver({ from: systemFrom(), to, subject: 'Your ScopeGov password was changed', html })
}

// ── Workspace deleted ─────────────────────────────────────────
// FIX (deep audit, Workspace lifecycle section): deleting a workspace
// silently deactivates every OTHER active member's access with zero
// warning — no email, no notification, nothing. Every other consequential
// account-level event in this codebase (MFA changes, password changes)
// emails the affected person; a team's entire workspace disappearing out
// from under them got nothing. Sent to every active member except the
// one who performed the deletion, before their membership is deactivated.
export async function sendWorkspaceDeletedEmail(params: { to: string; name: string; agencyName: string; deletedByName: string }) {
  const { to, name: nameRaw, agencyName: agencyNameRaw, deletedByName: deletedByRaw } = params
  const name = escapeHtml(nameRaw)
  const agencyName = escapeHtml(agencyNameRaw)
  const deletedBy = escapeHtml(deletedByRaw)
  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.red,
    headerIcon: '🗑️',
    label: 'Workspace',
    headline: `${agencyName} has been deleted`,
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${name},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        ${deletedBy} deleted the <strong>${agencyName}</strong> workspace on ScopeGov. Your access to its
        projects, documents, and data has ended.
      </p>
      <p style="font-size:13px;color:${C.text2};">
        Didn't expect this? Contact ${deletedBy} directly to find out more.
      </p>
    `,
  })
  return deliver({ from: systemFrom(), to, subject: `${agencyNameRaw} has been deleted`, html })
}

// ── Workspace created ────────────────────────────────────────
// FIX (deep audit, Workspace lifecycle + Onboarding re-pass — feature
// gap): sendWorkspaceDeletedEmail above exists specifically because a
// workspace-ending event got no email at all — but the symmetric,
// arguably more emotionally significant event, a brand-new user's very
// first workspace being created, sent nothing either. Every other
// consequential event in this file (SOW sent, SOW signed, SOW declined,
// password changed, MFA changed, workspace deleted) confirms itself by
// email; workspace creation was the one gap left. Sent once, to the
// creator, right after workspace/create succeeds.
export async function sendWorkspaceCreatedEmail(params: { to: string; name: string; agencyName: string }) {
  const { to, name: nameRaw, agencyName: agencyNameRaw } = params
  const name = escapeHtml(nameRaw)
  const agencyName = escapeHtml(agencyNameRaw)
  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.green,
    headerIcon: '🎉',
    label: 'Workspace',
    headline: `Welcome to ${agencyName}`,
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${name},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        Your <strong>${agencyName}</strong> workspace on ScopeGov is ready. Finish setting it up — branding,
        defaults, and inviting your team — and you'll be ready to send your first Statement of Work.
      </p>
      <p style="font-size:13px;color:${C.text2};">
        Didn't create this? You can safely ignore this email.
      </p>
    `,
    cta: 'Finish setting up →',
    ctaUrl: `${process.env.NEXT_PUBLIC_APP_URL}/onboarding`,
  })
  return deliver({ from: systemFrom(), to, subject: `Welcome to ${agencyNameRaw} on ScopeGov`, html })
}

// ── Workspace restored ───────────────────────────────────────
// FEATURE (deep audit, Workspace lifecycle + Onboarding re-pass —
// feature gap): sendWorkspaceDeletedEmail above tells the OTHER members
// their access ended; there was nothing symmetric for when the owner
// undoes that within the restore window (see restore_workspace_atomic,
// migration 065) — the one workspace-lifecycle transition in this file
// that would otherwise confirm nothing to anyone. Sent to the restorer
// and, best-effort, to every member whose access just came back.
//
// FIX (deep audit, Workspace lifecycle + Onboarding re-pass — round 2,
// minor): restore_workspace_atomic (migration 065) only repoints
// active_workspace_id for the RESTORER — deliberately, per its own
// comment, so a member who'd moved on to using another workspace in the
// meantime isn't yanked back somewhere they didn't ask to go. That left
// this email's `cta: 'Open workspace →'` pointing every non-restorer
// recipient straight at '/dashboard', which resolves to whatever THEIR
// active workspace already is — not this one. The workspace does show up
// correctly in their switcher, but the one-click promise didn't hold.
// Route non-restorers through /workspace-open, which switches them into
// this specific workspace first, then lands them on /dashboard for real.
export async function sendWorkspaceRestoredEmail(params: { to: string; name: string; agencyName: string; restoredByName: string; isRestorer: boolean; workspaceId: string }) {
  const { to, name: nameRaw, agencyName: agencyNameRaw, restoredByName: restoredByRaw, isRestorer, workspaceId } = params
  const name = escapeHtml(nameRaw)
  const agencyName = escapeHtml(agencyNameRaw)
  const restoredBy = escapeHtml(restoredByRaw)
  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.green,
    headerIcon: '↩️',
    label: 'Workspace',
    headline: `${agencyName} has been restored`,
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${name},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        ${isRestorer
          ? `You restored the <strong>${agencyName}</strong> workspace on ScopeGov. Everything — projects, documents, and data — is back exactly as it was when it was deleted.`
          : `${restoredBy} restored the <strong>${agencyName}</strong> workspace on ScopeGov. Your access to its projects, documents, and data is back.`}
      </p>
      <p style="font-size:13px;color:${C.text2};">
        Didn't expect this? Contact ${isRestorer ? 'your workspace administrator' : restoredBy} directly to find out more.
      </p>
    `,
    cta: 'Open workspace →',
    ctaUrl: isRestorer
      ? `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`
      : `${process.env.NEXT_PUBLIC_APP_URL}/workspace-open?id=${workspaceId}`,
  })
  return deliver({ from: systemFrom(), to, subject: `${agencyNameRaw} has been restored`, html })
}

// ══════════════════════════════════════════════════════════════
// Notifications & email fix round — team lifecycle senders
// ══════════════════════════════════════════════════════════════

// FEATURE: ownership transfers, role changes, deactivation/reactivation and project assignment
// all wrote audit rows but told nobody. The first three concern the person's own access, so they
// are sent regardless of notification preferences (like the MFA notices).
// ── Team lifecycle (internal) ─────────────────────────────────
// FEATURE: ownership transfers, role changes, deactivation and project
// assignment all wrote audit rows but told nobody. The first three are
// security-relevant to the person concerned, so they're sent regardless of
// notification preferences (like the MFA notices).
export async function sendOwnershipTransferredEmail(params: {
  to: string[]; agencyName: string; newOwnerName: string; formerOwnerName: string
}) {
  const { to, agencyName: agencyNameRaw, newOwnerName: newRaw, formerOwnerName: formerRaw } = params
  const agencyName = escapeHtml(agencyNameRaw)
  const newOwner   = escapeHtml(newRaw)
  const former     = escapeHtml(formerRaw)
  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.gold,
    headerIcon: '🔑',
    label: 'Security',
    headline: `Ownership of ${agencyName} was transferred`,
    body: `
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        <strong>${former}</strong> transferred ownership of the <strong>${agencyName}</strong> workspace
        to <strong>${newOwner}</strong>. The new owner now controls billing, roles and workspace deletion.
      </p>
      <p style="font-size:13px;color:${C.text2};">
        Wasn't expected? Contact the people involved right away.
      </p>
    `,
    ctaUrl: `${process.env.NEXT_PUBLIC_APP_URL}/team`,
    cta: 'View team →',
  })
  return deliver({ from: systemFrom(), to, subject: `Ownership of ${agencyNameRaw} was transferred`, html })
}

export async function sendMemberRoleChangedEmail(params: {
  to: string; name: string; agencyName: string; roleName?: string | null; changedByName: string
}) {
  const { to, name: nameRaw, agencyName: agencyNameRaw, roleName: roleRaw, changedByName: byRaw } = params
  const name = escapeHtml(nameRaw), agencyName = escapeHtml(agencyNameRaw)
  const role = roleRaw ? escapeHtml(roleRaw) : '', by = escapeHtml(byRaw)
  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.green,
    headerIcon: '🔑',
    label: 'Your access',
    headline: role ? `Your role in ${agencyName} changed` : `Your permissions in ${agencyName} changed`,
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${name},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        ${role
          ? `<strong>${by}</strong> changed your role in <strong>${agencyName}</strong> to <strong>${role}</strong>.`
          : `<strong>${by}</strong> adjusted your permissions in <strong>${agencyName}</strong>.`}
        What you can see and do in the workspace may have changed with it.
      </p>
    `,
    ctaUrl: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`,
    cta: 'Open ScopeGov →',
  })
  return deliver({ from: systemFrom(), to, subject: roleRaw ? `Your role in ${agencyNameRaw} is now ${roleRaw}` : `Your permissions in ${agencyNameRaw} changed`, html })
}

export async function sendMemberAccessChangedEmail(params: {
  to: string; name: string; agencyName: string; change: 'deactivated' | 'reactivated'; changedByName: string
}) {
  const { to, name: nameRaw, agencyName: agencyNameRaw, change, changedByName: byRaw } = params
  const name = escapeHtml(nameRaw), agencyName = escapeHtml(agencyNameRaw), by = escapeHtml(byRaw)
  const off = change === 'deactivated'
  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: off ? C.amber : C.green,
    headerIcon: '🔑',
    label: 'Your access',
    headline: off ? `Your access to ${agencyName} was turned off` : `Your access to ${agencyName} was restored`,
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${name},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        ${off
          ? `<strong>${by}</strong> deactivated your account in <strong>${agencyName}</strong>. You can no longer sign in to that workspace. If you think this is a mistake, contact the workspace owner.`
          : `<strong>${by}</strong> reactivated your account in <strong>${agencyName}</strong>. You can sign in again.`}
      </p>
    `,
    ...(off ? {} : { ctaUrl: `${process.env.NEXT_PUBLIC_APP_URL}/login`, cta: 'Sign in →' }),
  })
  return deliver({
    from: systemFrom(), to,
    subject: off ? `Your access to ${agencyNameRaw} was turned off` : `Your access to ${agencyNameRaw} was restored`,
    html,
  })
}

export async function sendProjectAssignedEmail(params: {
  to: string[]; projectName: string; assignedByName: string; agencyName: string; projectUrl: string
}) {
  const { to, projectName: projectRaw, assignedByName: byRaw, agencyName: agencyRaw, projectUrl } = params
  if (to.length === 0) return { ok: true, id: null, skipped: true } as SendResult
  const projectName = escapeHtml(projectRaw), by = escapeHtml(byRaw)
  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.green,
    headerIcon: '📁',
    label: 'Project access',
    headline: `You were added to ${projectName}`,
    showPreferencesLink: true,
    body: `
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        <strong>${by}</strong> added you to <strong>${projectName}</strong> in ${escapeHtml(agencyRaw)}.
        It now appears in your projects list.
      </p>
    `,
    ctaUrl: projectUrl,
    cta: 'Open project →',
  })
  return deliver({ from: systemFrom(), to, subject: `You were added to ${projectRaw}`, html })
}

// ── Cron/portal audit round 2 ─────────────────────────────────────

// Client-facing automatic nudge for an unsigned SOW or an unanswered change order (cron/client-reminders).
// (Invoices reuse sendInvoiceReminderEmail.) Mirrors the wording of the manual "Remind" buttons.
export async function sendClientDocumentReminderEmail(params: {
  replyTo?: string | null; log?: EmailLogContext
  kind: 'sow' | 'co'
  to: string; cc?: string[]; clientName: string; agencyName: string
  projectName: string; documentTitle?: string | null
  portalUrl: string; brandColour?: string; expiresAt?: string | null
  /** 'awaiting_countersignature' COs need a signature on the agreed counter amount, not a first answer. */
  needsCountersignature?: boolean
}) {
  const { kind, to, cc, clientName: clientNameRaw, agencyName: agencyNameRaw, projectName: projectNameRaw,
    documentTitle: documentTitleRaw, portalUrl, brandColour, expiresAt, needsCountersignature } = params
  const clientName    = escapeHtml(clientNameRaw)
  const agencyName    = escapeHtml(agencyNameRaw)
  const projectName   = escapeHtml(projectNameRaw)
  const documentTitle = escapeHtml(documentTitleRaw)

  const isSow = kind === 'sow'
  const headline = isSow ? 'Your agreement is waiting to be signed'
    : needsCountersignature ? 'A change order needs your signature' : 'A change order is waiting for your response'
  const what = isSow
    ? `your Statement of Work for <strong>${projectName}</strong>`
    : `the change order${documentTitle ? ` <strong>${documentTitle}</strong>` : ''} on <strong>${projectName}</strong>`
  const status = isSow ? 'is still awaiting your signature'
    : needsCountersignature ? 'is ready for your signature' : 'is still awaiting your response'

  const html = baseTemplate({
    agencyName,
    headerColour: brandColour || C.green,
    label: 'Reminder',
    headline,
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${clientName},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        A friendly reminder from <strong>${agencyName}</strong> that ${what} ${status}.
      </p>
      ${expiresAt ? `<p style="font-size:12px;color:${C.text3};margin:0 0 16px;">This link expires ${new Date(expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}.</p>` : ''}
    `,
    cta: isSow ? 'Review & sign →' : needsCountersignature ? 'Review & sign →' : 'Review & respond →',
    ctaUrl: portalUrl,
  })

  return deliver({
    from:    formatFrom(agencyNameRaw),
    replyTo: params.replyTo,
    to,
    cc:      cc?.filter(Boolean) || [],
    subject: `Reminder: ${isSow ? `please review and sign the ${projectNameRaw} agreement`
      : `${documentTitleRaw || 'change order'} — ${projectNameRaw}`}`,
    html,
  }, params.log)
}

// Sent to the client when the agency closes out an invoice dispute (api/invoices/[id]/dispute-resolve).
export async function sendInvoiceDisputeResolvedEmail(params: {
  replyTo?: string | null; log?: EmailLogContext
  to: string; cc?: string[]; clientName: string; agencyName: string
  projectName: string; invoiceNumber?: string | null; note?: string | null
  portalUrl: string; brandColour?: string
}) {
  const { to, cc, clientName: clientNameRaw, agencyName: agencyNameRaw, projectName: projectNameRaw,
    invoiceNumber, note: noteRaw, portalUrl, brandColour } = params
  const clientName  = escapeHtml(clientNameRaw)
  const agencyName  = escapeHtml(agencyNameRaw)
  const projectName = escapeHtml(projectNameRaw)
  const note        = escapeHtml(noteRaw)

  const html = baseTemplate({
    agencyName,
    headerColour: brandColour || C.green,
    label: 'Invoice query',
    headline: 'Your invoice question has been answered',
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${clientName},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        <strong>${agencyName}</strong> has reviewed the question you raised on invoice${invoiceNumber ? ` ${invoiceNumber}` : ''}
        for <strong>${projectName}</strong> and marked it resolved.
      </p>
      ${note ? `
      <div style="background:${C.bg};border:1px solid ${C.border};border-radius:6px;padding:14px 16px;margin:16px 0;">
        <p style="font-size:11px;color:${C.text3};text-transform:uppercase;letter-spacing:.05em;margin:0 0 6px;">Their response</p>
        <p style="font-size:13px;color:${C.text2};margin:0;line-height:1.6;white-space:pre-line;">${note}</p>
      </div>` : ''}
      <p style="font-size:13px;color:${C.text2};margin:0;">If anything is still unclear you can raise it again from the invoice page.</p>
    `,
    cta: 'View invoice →',
    ctaUrl: portalUrl,
  })

  return deliver({
    from:    formatFrom(agencyNameRaw),
    replyTo: params.replyTo,
    to,
    cc:      cc?.filter(Boolean) || [],
    subject: `Your question on invoice${invoiceNumber ? ` ${invoiceNumber}` : ''} — ${projectNameRaw}`,
    html,
  }, params.log)
}

// ── Security: new sign-in from an unrecognised device (audit round 2) ─────
// Sent by lib/auth/session-seen.ts the first time the app sees a session whose
// browser/OS the account hasn't used in the last 90 days. Carries what a person
// needs to judge it — when, from where (IP), on what — and the one action to take.
export async function sendNewSignInEmail(params: {
  to: string; name: string; when: string; ip: string | null; device: string; settingsUrl: string
}) {
  const { to, name: nameRaw, when, ip, device, settingsUrl } = params
  const name = escapeHtml(nameRaw)
  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.amber,
    headerIcon: '🛡️',
    label: 'Security',
    headline: 'New sign-in to your account',
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${name},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 12px;">
        Your ScopeGov account was just signed in to from a device we haven't seen recently.
      </p>
      <table style="font-size:13px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        <tr><td style="padding-right:14px;color:${C.text};">When</td><td>${escapeHtml(when)}</td></tr>
        <tr><td style="padding-right:14px;color:${C.text};">Device</td><td>${escapeHtml(device)}</td></tr>
        <tr><td style="padding-right:14px;color:${C.text};">IP address</td><td>${escapeHtml(ip || 'unknown')}</td></tr>
      </table>
      <p style="font-size:13px;color:${C.text2};line-height:1.7;">
        If this was you, there is nothing to do. If it wasn't,
        <a href="${escapeHtml(settingsUrl)}" style="color:${C.green};">sign out every session and change your password</a>
        straight away.
      </p>
    `,
  })
  return deliver({ from: systemFrom(), to, subject: 'New sign-in to your ScopeGov account', html })
}

// ── Security: sign-in email change requested (sent to the OLD address) ────
export async function sendEmailChangeRequestedEmail(params: { to: string; name: string; newEmail: string; settingsUrl: string }) {
  const { to, name: nameRaw, newEmail, settingsUrl } = params
  const name = escapeHtml(nameRaw)
  const html = baseTemplate({
    agencyName: 'ScopeGov',
    headerColour: C.amber,
    headerIcon: '✉️',
    label: 'Security',
    headline: 'A sign-in email change was requested',
    body: `
      <p style="font-size:14px;color:${C.text};line-height:1.7;margin:0 0 16px;">Hi ${name},</p>
      <p style="font-size:14px;color:${C.text2};line-height:1.7;margin:0 0 16px;">
        Someone asked to change the sign-in email on your ScopeGov account to
        <strong>${escapeHtml(newEmail)}</strong>. Nothing changes until that address is confirmed.
      </p>
      <p style="font-size:13px;color:${C.text2};line-height:1.7;">
        Didn't request this? <a href="${escapeHtml(settingsUrl)}" style="color:${C.green};">Sign out every session and change your password</a>.
      </p>
    `,
  })
  return deliver({ from: systemFrom(), to, subject: 'A sign-in email change was requested on your ScopeGov account', html })
}

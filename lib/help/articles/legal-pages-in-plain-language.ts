// lib/help/articles/legal-pages-in-plain-language.ts
//
// Checked 2026-10-30 against: app/legal/{terms,privacy,dpa,security,cookies}/page.tsx (all dated October 2026; Terms version 2026-10 in lib/auth/terms.ts),
// components/portal/PortalLegalFooter.tsx, app/(auth)/{signup,login}. This is a reader's guide to what those pages SAY, not legal advice, and it must be
// re-checked whenever any legal page changes (tests/legal-pages-accuracy.test.ts guards the pages themselves, not this summary).

import type { HelpArticle } from '../types'

export const legalPagesInPlainLanguage: HelpArticle = {
  slug: 'legal-pages-in-plain-language',
  title: 'What do ScopeGov\u2019s Terms, Privacy Policy and other legal pages mean in plain language?',
  summary: 'A plain-English guide to who owns what, who is responsible for what, how long data is kept, and where to send questions.',
  category: 'integrations-security',
  order: 11,
  audience: { permissions: [], plan: 'all' },
  shortAnswer:
    'Your content stays yours, and ScopeGov uses it only to run the service for you. You stay responsible for what you send your clients, including AI-drafted text and e-signatures. ' +
    'For your clients\u2019 personal data you are the controller and ScopeGov is the processor. This guide summarises the pages as they read in October 2026. It is not legal advice, and the pages themselves are what binds you.',
  beforeYouStart: [
    'The pages are at /legal/terms, /legal/privacy, /legal/dpa, /legal/security and /legal/cookies. The sign-in and sign-up pages link to the Terms and Privacy Policy, and so does the footer of your clients\u2019 signing pages.',
    'Each page shows when it was last updated. Check the date when you read this guide, because the pages can change.',
  ],
  steps: [
    {
      title: 'Terms of Service: the agreement',
      body: 'It is an agreement between you (or your agency) and Saltern Studio Ltd., a company registered in Kenya, which operates ScopeGov. It covers scopegov.app and the client signing site, sign.scopegov.app.',
      details: [
        'By creating an account you accept it. If you accept for a company, you confirm you have authority to bind it.',
        'You are responsible for the accuracy of what you enter and for activity under your account. Owners decide who has access and what each person can do.',
        'You own your SOWs, change orders, client records and other content. ScopeGov gets a limited licence to host and process them to provide the service, and does not use them to train models for other customers.',
        'You must have the right to put client and third-party data into ScopeGov.',
      ],
    },
    {
      title: 'Terms: AI, signing and what you are still responsible for',
      body: 'Guardian and AI drafting are decision support. A Guardian flag is a suggestion, and nothing goes to a client or becomes a change order without a person on your team approving it.',
      details: [
        'ScopeGov does not promise Guardian will catch every case of scope creep, or that AI-drafted wording is legally sufficient. You review what you send.',
        'You are responsible for making sure electronic signature is valid for your agreements and jurisdiction. ScopeGov provides the signing tool, not a legal opinion that it suffices.',
        'Prohibited use includes sending fraudulent or deliberately inaccurate scope or billing documents, getting around permissions or the audit trail, reselling access, and uploading content you have no right to share.',
      ],
    },
    {
      title: 'Terms: plans, billing and read-only mode',
      body: 'Plans renew automatically, billed monthly or annually in advance through Paystack, until cancelled.',
      details: [
        'New workspaces get a 14-day free trial with no card needed. Upgrading ends the trial.',
        'Each plan includes a monthly allowance of AI drafts, counted per calendar month in UTC. A request that fails or returns nothing usable does not count. When it is used up, AI drafting pauses, and everything else carries on.',
        'If a renewal fails, there is a 5-day grace period. If it is still unresolved, or the trial or subscription ends, the workspace becomes read-only.',
        'Read-only means you can view content, download exports, manage billing and settings (including deleting the workspace), and your clients can still open and answer documents already sent. You cannot create, edit or send documents, invite people, approve, change roles or delete projects.',
        'Cancellation takes effect at the end of the paid period. There are no partial-period refunds. Refunds are given for charges made in error, for an annual renewal if you ask within 7 days, and where the law requires. Ask at support@scopegov.app.',
      ],
    },
    {
      title: 'Terms: limits, disputes and changes',
      body: 'The service is provided \u201cas is\u201d, with no promise it will be uninterrupted or error-free.',
      details: [
        'Neither side is liable for indirect or consequential damages. ScopeGov\u2019s total liability for a claim is capped at the greater of what you paid in the previous 12 months and USD 100, except where the law does not allow a cap.',
        'You agree to indemnify ScopeGov against claims arising from your content, from breaking the Terms, or from violating someone else\u2019s rights.',
        'Kenyan law applies. Disputes start with written notice to legal@scopegov.app and 30 days of good-faith talks, then arbitration in Nairobi under the Nairobi Centre for International Arbitration rules, before one arbitrator, in English. Either side may go to the Nairobi courts for urgent injunctions.',
        'For material changes, ScopeGov emails or notifies workspace owners before they take effect. Continuing to use the service means you accept them.',
      ],
    },
    {
      title: 'Privacy Policy: what is collected and who sees it',
      body: 'It explains what ScopeGov collects through scopegov.app and the client signing site, and why.',
      details: [
        'Agency accounts: name, work email, a hashed password, workspace and role, and an authenticator if you enable one. Google sign-in shares your name and email.',
        'Your content and your clients\u2019 details as you enter them. When a client signs, ScopeGov also records the signature, the time, and their IP address and browser details as evidence.',
        'Forwarded client emails sent to a project\u2019s Guardian address are read to check them against the signed scope.',
        'Card details are handled by Paystack. ScopeGov stores the plan and subscription status, not card numbers.',
        'Your profile photo and agency logo are public to anyone with the image address. Attachments and evidence files are private to the workspace.',
        'ScopeGov says it does not sell personal data and does not use analytics for marketing.',
      ],
    },
    {
      title: 'Privacy Policy: AI, subprocessors and where data lives',
      body: 'Drafting and Guardian send the relevant text to Anthropic\u2019s Claude API. Search over your SOW history uses OpenAI\u2019s embeddings.',
      details: [
        'Only what a request needs is sent, such as one project\u2019s SOW and the message being checked, not your whole workspace.',
        'The subprocessors named are Supabase (database, sign-in, files), Vercel (hosting), Anthropic, OpenAI, Resend (outgoing email and receiving forwarded email for Guardian), Paystack (billing), Google (only if you use Google sign-in), and Cloudflare and GitHub (they trigger scheduled jobs and see no customer content).',
        'Data is stored with Supabase in the EU (Ireland), the app runs on Vercel in the United States, and ScopeGov is operated from Kenya. Transfers rely on the providers\u2019 standard contractual clauses or equivalent.',
        'Questions and rights requests go to privacy@scopegov.app. If a client\u2019s data was entered by your agency, requests are generally sent back to you first.',
      ],
    },
    {
      title: 'Privacy Policy: how long things are kept',
      body: 'Content is kept for as long as the workspace exists, with these exceptions.',
      details: [
        'A lapsed workspace becomes read-only and is kept until an owner deletes it or you ask. It is not purged automatically.',
        'A deleted workspace can be restored by an owner for 30 days. After that it is inaccessible, but the data is kept for 7 years for tax, accounting and legal-claim reasons, then permanently deleted.',
        'Deleted Draft or Intake projects are permanently removed after 30 days.',
        'A deleted account has its profile and sign-in details erased 30 days later. Records it created inside a workspace stay with the workspace.',
        'The audit log is kept for the life of the workspace. Read notifications are deleted after 90 days, and unread ones after 180.',
        'You can ask for earlier deletion at any time, and it is honoured unless the law requires keeping the data.',
      ],
    },
    {
      title: 'Data Processing Addendum (DPA)',
      body: 'It applies to the personal data of your team, your clients and their signers that you put into ScopeGov. You are the controller of that data, and ScopeGov is the processor.',
      details: [
        'ScopeGov processes it only on your instructions, including the way you configure the service, and keeps staff under confidentiality.',
        'It gives owners at least 14 days\u2019 email notice before adding a new subprocessor, so you can object on reasonable data-protection grounds.',
        'Requests from your clients\u2019 contacts are forwarded to you, not answered directly, with reasonable help.',
        'ScopeGov will tell you of a confirmed breach affecting your data without undue delay and within 72 hours of becoming aware.',
        'On request it answers a written security questionnaire, at most once a year, and points to the Security page. It does not offer on-site audits.',
        'It forms part of the Terms, so there is nothing separate to sign. The EU and UK standard contractual clauses are included by reference, and on data protection, the DPA wins if the two conflict.',
      ],
    },
    {
      title: 'Security page and Cookie Policy',
      body: 'The Security page lists the protections. The Cookie Policy lists what is stored in your browser.',
      details: [
        'Security: each workspace\u2019s data is separated by row-level security and by checks in the application; secrets such as signing keys sit in a table nobody can query directly; passwords are hashed; traffic is encrypted; sessions use Secure cookies; and governance actions go in an append-only audit log.',
        'The Terms and the Security page describe two-factor as required for governance-level permissions such as approving documents or changing settings. In the app, your **Account** page shows **Required, not set up** or **Recommended**, depending on how enforcement is set for your workspace. Set it up either way.',
        'To report a vulnerability, email security@scopegov.app and allow a reasonable time to fix it before disclosing.',
        'Cookies: sign-in cookies (strictly necessary, for up to 400 days), a short-lived sign-in verification cookie, and a 30-day referral cookie named ss_ref. There are no advertising cookies and no cross-site tracking.',
        'The setup wizard remembers progress in your browser, and Paystack\u2019s own script loads when you open billing checkout.',
      ],
    },
  ],
  dos: [
    'Read the Terms, the Privacy Policy and the DPA once, and again when you are told they have changed.',
    'Review every AI-drafted document yourself before it goes to a client.',
    'Check that e-signature is acceptable for your contracts where you work.',
    'Download exports before you cancel, or leave a lapsed workspace.',
  ],
  donts: [
    'Do not treat this guide as legal advice, or as a replacement for the pages.',
    'Do not put client data into ScopeGov that you have no right to share.',
    'Do not promise a client that Guardian will catch everything.',
    'Do not ask a client to contact ScopeGov about their own data. Requests come back to you.',
  ],
  problems: [
    {
      symptom: 'A client asks you to delete or correct their personal data',
      meaning: 'You are the controller. ScopeGov will pass any request it receives to you.',
      fix: 'Use the client, contact and project tools in ScopeGov, or ask privacy@scopegov.app for help with something you cannot do yourself.',
    },
    {
      symptom: 'Your security team wants a questionnaire or evidence',
      meaning: 'The DPA offers a written questionnaire and points to the Security page.',
      fix: 'Email privacy@scopegov.app. The pages do not claim any certification.',
    },
    {
      symptom: 'You want your data deleted early',
      meaning: 'You can ask at any time, and ScopeGov will do it unless the law requires it to keep a copy.',
      fix: 'Email privacy@scopegov.app. Download what you need first.',
    },
    {
      symptom: 'You were told the Terms changed',
      meaning: 'Owners are notified before material changes take effect.',
      fix: 'Read the new version. Continuing to use ScopeGov means you accept it. If you do not, you can cancel.',
    },
    {
      symptom: 'You need a signed DPA',
      meaning: 'The DPA is part of the Terms and needs no separate signature.',
      fix: 'Link or attach /legal/dpa. For questions, email legal@scopegov.app.',
    },
    {
      symptom: 'A refund is needed',
      meaning: 'Refunds are limited to charges made in error, annual renewals asked about within 7 days, and legal requirements.',
      fix: 'Email support@scopegov.app with the charge details.',
    },
  ],
  whatHappensNext: [
    'Using ScopeGov means you accept the Terms and Privacy Policy as they stand. Material changes are announced to owners first.',
    'Questions go to the address that fits: legal@scopegov.app, privacy@scopegov.app, security@scopegov.app or support@scopegov.app.',
    'If a page changes, this guide may be out of date, so read the current page.',
  ],
  related: ['read-only-workspace', 'export-before-you-leave', 'forward-client-emails-to-guardian', 'mfa-set-up-two-factor'],
  updated: '2026-10-30',
}

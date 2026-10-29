// lib/help/articles/export-before-you-leave.ts
// Checked against the product code on 2026-10-29: app/api/{invoices,reports,reports/audit-export,reports/portfolio}/export, app/api/pdf/{sow,co,invoice},
// components/projects/ProjectDetail.tsx, components/co/CoEditor.tsx, app/(app)/reports/page.tsx, components/settings/AuditLogClient.tsx,
// components/settings/SettingsClient.tsx (Danger zone), app/api/workspace/delete/route.ts, lib/billing/entitlements.ts (READ_ONLY_FEATURES).
// NOTE: there is no single "export everything" feature; this article lists the pieces honestly.

import type { HelpArticle } from '../types'

export const exportBeforeYouLeave: HelpArticle = {
  slug: 'export-before-you-leave',
  title: 'How do I get my data out before I cancel or leave?',
  summary: 'Download your documents, invoices, reports and audit log, and understand what cancelling and deleting actually do.',
  category: 'billing-plans',
  order: 4,
  audience: { permissions: ['VIEW_FINANCIALS'], plan: 'all' },
  shortAnswer:
    'There is no single export-everything button. You export in pieces: signed documents as PDF, invoices as a spreadsheet, reports and the audit log as CSV or PDF. ' +
    'All of these still work after you cancel, because a cancelled workspace becomes read-only, not deleted.',
  beforeYouStart: [
    'The permissions for what you export: View Financials for invoices and PDFs, View All Projects for reports, View Audit Log for the audit log.',
    'Somewhere to keep the files, and a rule for which projects you need to archive.',
  ],
  steps: [
    {
      title: 'Download your documents as PDF',
      minutes: 5,
      body: 'Open each project. On the **SOW** tab, click **Download PDF** on the signed SOW. Change orders have **Download PDF** in their editor. On the [Invoices](/invoices) page, each invoice has a PDF link.',
      details: [
        'PDF is the readable record of what the client agreed to.',
        'Download the signed version, not a draft.',
      ],
    },
    {
      title: 'Export your invoices',
      minutes: 2,
      body: 'On [Invoices](/invoices), use the export to download the ledger as a CSV that opens in Excel or Google Sheets. See \u201cExporting your invoices to a spreadsheet\u201d for the filters.',
    },
    {
      title: 'Export reports',
      minutes: 2,
      body: 'On [Reports](/reports), choose the tab, the period and the currency, then click **CSV** or **PDF**. The **Financial overview** export also needs View Financials.',
    },
    {
      title: 'Export the audit log',
      minutes: 2,
      body: 'Open [Settings \u2192 Audit log](/settings/audit) and click **CSV** or **PDF**. The in-app log is on every plan, but export needs the Agency plan or a trial, and stays available after you cancel.',
    },
    {
      title: 'Know what cancelling does',
      minutes: 1,
      body: 'Cancelling keeps access until the end of the paid period, then the workspace becomes read-only. Nothing is deleted, and you can still view and export.',
      details: [
        'You can subscribe again at any time to carry on where you left off.',
        'See \u201cHow do I switch plans, update my card, cancel or resume?\u201d for the steps.',
      ],
    },
    {
      title: 'Deleting is a different, stricter step',
      minutes: 2,
      body: 'Only the workspace Owner can delete it, under [Settings](/settings?tab=danger) \u2192 **Danger zone** \u2192 **Delete workspace**, by typing the workspace name.',
      details: [
        'Every member loses access straight away, and the subscription is cancelled.',
        'You can restore it for 30 days from the \u201cRecently deleted\u201d list. After that it cannot be brought back.',
        'Workspaces with signed documents, documents awaiting a client, accepted or open change orders, recorded payments or unpaid invoices cannot be deleted. Contact support@scopegov.app.',
      ],
      watchFor: 'For most working agencies deleting is refused. Cancelling is the normal way to stop paying.',
    },
  ],
  dos: [
    'Export before the date your subscription ends, to be safe.',
    'Keep signed PDFs with your other contracts.',
    'Export the audit log if you need the record of who did what.',
    'Cancel rather than delete if you may come back.',
  ],
  donts: [
    'Do not delete the workspace to stop billing. Cancel the subscription.',
    'Do not rely on drafts. Download the signed version.',
    'Do not forget the invoice ledger if you need your payment history.',
    'Do not assume deletion is allowed. It is refused with signed or unpaid documents.',
  ],
  problems: [
    {
      symptom: 'I cannot find an \u201cexport all\u201d button',
      meaning: 'There is not one. Each kind of data exports separately.',
      fix: 'Follow the steps above. If you need a full data copy, email support@scopegov.app and say what you need.',
    },
    {
      symptom: 'There is no audit log export',
      meaning: 'It is included with the Agency plan and the trial.',
      fix: 'Upgrade, or use the in-app log, which is open on every plan.',
    },
    {
      symptom: 'The workspace will not delete',
      meaning: 'It contains documents or payments that the workspace is not allowed to remove.',
      fix: 'Cancel the subscription instead, or contact support@scopegov.app.',
    },
    {
      symptom: 'I cannot download a PDF',
      meaning: 'PDFs of priced documents need the View Financials permission.',
      fix: 'Ask an admin to add it, or ask someone who has it to download the files.',
    },
  ],
  whatHappensNext: [
    'After cancelling, the workspace becomes read-only at the end of the paid period. Your data is kept.',
    'You can come back by subscribing again. Nothing needs to be re-imported.',
    'Deleted workspaces are retained for 7 years for legal compliance before permanent removal.',
  ],
  related: ['change-or-cancel-plan', 'read-only-workspace', 'export-invoices'],
  updated: '2026-10-29',
}

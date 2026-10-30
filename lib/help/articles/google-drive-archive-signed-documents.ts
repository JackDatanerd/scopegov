// lib/help/articles/google-drive-archive-signed-documents.ts
//
// Checked 2026-10-30 against: components/settings/IntegrationsSection.tsx (Google Drive block, DRIVE_RESULT), app/api/integrations/google/callback,
// app/api/workspace/integrations/google-drive/*, lib/integrations/{drive-archive,drive-config,google-config,google}.ts.

import type { HelpArticle } from '../types'

export const googleDriveArchiveSignedDocuments: HelpArticle = {
  slug: 'google-drive-archive-signed-documents',
  title: 'How do I keep a copy of every signed SOW in Google Drive?',
  summary: 'Connect Google Drive so each signed SOW and accepted change order is saved as its original signed PDF in your own Drive.',
  category: 'integrations-security',
  order: 3,
  audience: { permissions: ['MANAGE_WORKSPACE_SETTINGS'], plan: 'pro' },
  shortAnswer:
    'In [Settings](/settings), open **Integrations** and click **Connect Google Drive**. From then on, each signed SOW and accepted change order is copied, as the exact PDF that was signed, into a **ScopeGov Archive** folder in your Drive, sorted by client and project. ' +
    'ScopeGov can see only the files and folders it creates there, nothing else in your Drive.',
  beforeYouStart: [
    'The Pro or Agency plan, or an active trial.',
    'The Manage Workspace Settings permission.',
    'A Google account with room in its Drive. Use the account your company owns, so the archive does not leave with a person.',
  ],
  steps: [
    {
      title: 'Connect',
      body: 'In [Settings](/settings), open **Integrations**. In the **Google Drive** box, click **Connect Google Drive** and sign in to Google.',
      details: [
        'Leave the Drive permission ticked on Google\u2019s screen: \u201cSee, edit, create and delete only the specific Google Drive files you use with this app\u201d. If you untick it, Drive is not connected.',
        'ScopeGov creates the **ScopeGov Archive** folder straight away. You see \u201cGoogle Drive is connected. Executed documents will now be copied to the \u201cScopeGov Archive\u201d folder.\u201d',
        'The box then shows \u201cConnected as\u201d your Google address.',
      ],
    },
    {
      title: 'Choose what to archive',
      body: 'Under **Archive**, tick **Signed SOWs**, **Accepted change orders**, or both. You can only tick what your own permissions allow: Send SOWs and Send Change Orders.',
    },
    {
      title: 'Archive what you already have',
      body: 'Click **Archive past documents** to copy earlier signed documents. It queues the most recent 200 of each type per click, and you can click once every 10 minutes.',
      details: [
        'Documents already in Drive are skipped, so running it twice does no harm.',
        'Run it again to reach older documents.',
      ],
    },
    {
      title: 'Find your files',
      body: 'Click **Open the folder**. Inside, files sit in a folder for the client, then the project, named like the document, for example a signed SOW with its version, or a change order with its number and title.',
      details: [
        'The box shows how many documents have been archived.',
      ],
    },
    {
      title: 'Pause or disconnect',
      body: 'Click **Turn off** to pause archiving, or **Disconnect** to revoke ScopeGov\u2019s access to your Drive.',
      details: [
        'Disconnecting asks you to confirm. The PDFs already in your Drive stay exactly where they are.',
      ],
    },
  ],
  dos: [
    'Connect a company-owned Google account.',
    'Click **Archive past documents** straight after connecting.',
    'Treat the Drive copy as your record. It is the PDF the client signed.',
    'Reconnect as soon as the box says it needs reconnecting.',
  ],
  donts: [
    'Do not move or rename the **ScopeGov Archive** folder and expect ScopeGov to follow it.',
    'Do not delete files and expect them to be restored on their own. Archived documents are recorded, so ScopeGov will not copy them again.',
    'Do not expect invoices in the archive. Only signed SOWs and accepted change orders are copied.',
    'Do not connect a personal account you may stop using.',
  ],
  problems: [
    {
      symptom: '\u201cGoogle Drive was not connected because the Drive permission was unticked\u201d',
      meaning: 'The one permission ScopeGov needs was not granted on Google\u2019s screen.',
      fix: 'Click **Connect Google Drive** again and leave that box ticked.',
    },
    {
      symptom: '\u201cGoogle accepted the sign-in but Drive could not be used\u201d',
      meaning: 'This is a problem on ScopeGov\u2019s side with its Google setup, not with your account.',
      fix: 'Contact support and quote the message.',
    },
    {
      symptom: 'The box says \u201cneeds reconnecting\u201d',
      meaning: 'Google stopped accepting ScopeGov\u2019s access, for example because you removed the app from your Google account. Archiving switched itself off.',
      fix: 'Click **Reconnect**.',
    },
    {
      symptom: 'An archive item is skipped with \u201cNo stored executed PDF exists for this document\u201d',
      meaning: 'The document was signed before ScopeGov stored a frozen copy, or storing it failed. ScopeGov will not recreate the PDF, because a new one could differ from what was signed.',
      fix: 'Nothing to do here. Download that document\u2019s PDF from its project instead.',
    },
    {
      symptom: 'Archiving turned itself off, and the note says your Drive is full or access was revoked',
      meaning: 'Google refused new files.',
      fix: 'Free some space, or reconnect, then click **Turn on**.',
    },
    {
      symptom: 'Files stopped appearing after you deleted the folder',
      meaning: 'ScopeGov notices a deleted or trashed folder and recreates the folders for the next document. Documents already archived are not copied again.',
      fix: 'Restore the folder from Drive\u2019s trash if you want the older files back.',
    },
  ],
  whatHappensNext: [
    'Each signed SOW and accepted change order is copied shortly after it happens, in the background.',
    'Archived documents are recorded, so retries and repeated catch-ups never make a second copy.',
    'If your plan lapses or the workspace becomes read-only, archiving stops until it is active again.',
  ],
  related: ['hubspot-sync-signed-sows', 'slack-updates-in-channel', 'export-before-you-leave', 'what-your-client-sees-sow'],
  updated: '2026-10-30',
}

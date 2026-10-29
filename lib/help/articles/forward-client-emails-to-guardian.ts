// lib/help/articles/forward-client-emails-to-guardian.ts
// Checked against the product code on 2026-10-29: app/api/guardian/inbound/route.ts, lib/ai/guardian-email.ts,
// GuardianTab and GuardianHistoryPanel in ProjectDetail, FlagSource.

import type { HelpArticle } from '../types'

export const forwardClientEmailsToGuardian: HelpArticle = {
  slug: 'forward-client-emails-to-guardian',
  title: 'How do I forward client emails to Guardian?',
  summary: 'Send a client’s email to the project’s Guardian address, and know what Guardian reads, what it throws away, and why nothing appears when an email is ignored.',
  category: 'guardian',
  order: 4,
  audience: { permissions: ['SUBMIT_GUARDIAN_CHECKS'], plan: 'all' },
  shortAnswer:
    'Open the project’s **Guardian** tab, copy the address under **Forward client emails to**, and forward the client’s email there using your mail app’s Forward. ' +
    'Guardian checks the client’s message just as if you had pasted it. Always use a real forward: a reply, or a forward whose subject you edited, makes Guardian read only your own words.',
  beforeYouStart: [
    'The project is **Active**. The address is shown only while Guardian is active.',
    'The email from your client that you want checked.',
  ],
  steps: [
    {
      title: 'Copy the project’s address',
      body: 'Open the project, click the **Guardian** tab and copy the address shown under **Forward client emails to**. It starts with proj-. Every project has its own address.',
      watchFor: 'Do not forward to another project’s address. The address decides which project’s scope is used.',
    },
    {
      title: 'Forward the client’s email',
      body: 'In your mail app, open the client’s email and choose **Forward**. Put the Guardian address in the To field and send.',
      details: [
        'Keep the subject starting with Fwd: or Fw:. That tells Guardian it is a forward, so it keeps the forwarded message and drops its header lines.',
        'You can type a note above the forwarded message. Guardian reads that too, so keep it short and factual.',
        'You do not need to wait for a reply. Guardian sends no confirmation email.',
      ],
    },
    {
      title: 'Find the result',
      body: 'Open the Guardian tab. Click **Check history** to see the message and its verdict, or look for a new flag.',
      details: [
        'Forwarded checks show the sender and subject. **View original request** on a flag shows the full text and attachment names.',
        'Because you forwarded it, the sender is you, so you may see an **Unrecognised sender** badge. That is expected for forwards from your own mailbox.',
      ],
    },
    {
      title: 'Check that it was picked up',
      body: 'If nothing appears after a few minutes, see the problems below. Several kinds of email are ignored silently.',
    },
  ],
  dos: [
    'Forward the client’s message itself, not a summary of it.',
    'Forward each new request as it arrives.',
    'Keep the Fwd: subject prefix.',
    'Use the paste box on the Guardian tab for text you cannot forward, such as chat messages.',
  ],
  donts: [
    'Do not reply to the client with the Guardian address in CC or BCC and expect their message to be checked. Guardian reads the new text of a reply, which is yours.',
    'Do not forward automatic replies, newsletters or out-of-office notices. They are skipped.',
    'Do not expect attachments or images to be read. Guardian reads text only.',
    'Do not share the address with clients or suppliers.',
  ],
  problems: [
    {
      symptom: 'I forwarded it and nothing appeared',
      meaning: 'Guardian silently ignores a message in these cases: the project is Complete or Archived, the project was paused by hand, it is an automatic reply or list mail, the text was only quoted earlier mail, or it was under 8 characters.',
      fix: 'Reopen or resume the project, or paste the client’s text into the Guardian tab instead.',
    },
    {
      symptom: 'The check shows only my own note, not the client’s message',
      meaning: 'The subject began with Re: or no longer began with Fwd:, so Guardian treated it as a reply and removed the quoted message.',
      fix: 'Forward again as a proper forward, or paste the client’s text into the paste box.',
    },
    {
      symptom: 'The same email is “Already processed”',
      meaning: 'Guardian recognises an email by its message ID, and has already stored it.',
      fix: 'Nothing to do. Look in **Check history**.',
    },
    {
      symptom: 'The history shows **Saved — will be checked automatically**',
      meaning: 'The email is stored but not checked yet, because the SOW is not signed, your workspace is read-only, or you hit a rate limit.',
      fix: 'It is checked automatically later. A check that stays unchecked for over 90 days shows **Never checked — too old for automatic checking**.',
    },
    {
      symptom: 'The check shows **Duplicate of a recent check — skipped**',
      meaning: 'It closely resembles a message checked in the last 30 days, counting only since the scope last changed.',
      fix: 'Open the earlier check in **Check history**.',
    },
    {
      symptom: 'A long email only partly shows',
      meaning: 'Text over 20,000 characters is cut off, keeping the beginning.',
      fix: 'Forward only the relevant message instead of a whole thread.',
    },
  ],
  whatHappensNext: [
    'Guardian cleans the email: it removes quoted replies, signatures and forward headers, and adds the subject as the first line.',
    'It then checks the text against the signed scope and creates a flag when needed. Your approvers are notified, including you if you can approve flags.',
    'Up to 10 attachment names are recorded and allowed file types are stored as evidence with the check. Guardian does not read them.',
    'Nothing is sent to your client.',
  ],
  related: ['what-guardian-does', 'check-client-message-verdict', 'guardian-good-bad-inputs'],
  updated: '2026-10-29',
}

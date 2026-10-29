// lib/help/articles/guardian-good-bad-inputs.ts
// Checked against the product code on 2026-10-29: lib/ai/guardian.ts (prompt, 20,000-character limit, outcome rules),
// lib/ai/guardian-pipeline.ts (duplicate detection: embeddingText, DEDUP_THRESHOLD, DEDUP_WINDOW_DAYS),
// lib/documents/post-signing.ts (scope snapshot), app/api/guardian/check and inbound routes.

import type { HelpArticle } from '../types'

export const guardianGoodBadInputs: HelpArticle = {
  slug: 'guardian-good-bad-inputs',
  title: 'Why did Guardian skip, misjudge or flag my pasted thread?',
  summary: 'What Guardian can and cannot judge, what to paste for the best verdict, and why a long thread gets one muddy answer or is skipped as a duplicate.',
  category: 'guardian',
  order: 5,
  audience: { permissions: ['SUBMIT_GUARDIAN_CHECKS'], plan: 'all' },
  shortAnswer:
    'Guardian gives one verdict for everything you submit, measured against the deliverable names and exclusions in your signed SOW. ' +
    'So it works best on a single, plain-text request. A long thread blurs several requests into one answer, and because duplicate detection only looks at the start and end of a message, a longer version of a thread you already checked can be skipped.',
  beforeYouStart: [
    'A signed SOW. Guardian has nothing to compare with before that.',
    'The client’s newest message, or just the sentence that contains the request.',
  ],
  steps: [
    {
      title: 'Paste one request at a time',
      body: 'Copy only the client’s latest request. If it refers back to something earlier (“like we discussed”), include the one line it refers to.',
      details: [
        'Guardian cannot tell which message in a thread is the new ask. It returns one verdict and one flag for the whole text.',
        'If the thread contains something already agreed and something new, you may get **Borderline**: it matches a deliverable and also looks like extra work.',
      ],
    },
    {
      title: 'Remove what is not the request',
      body: 'Delete quoted earlier messages, long signatures, legal footers and your own replies before pasting.',
      details: [
        'Forwarded emails are cleaned for you: quoted replies, signatures and forward headers are removed. Pasted text is not, apart from converting HTML to plain text.',
        'Your own wording is read as if the client had said it, so keep it out.',
      ],
    },
    {
      title: 'Put the request in words',
      body: 'Guardian reads text only. If the request is in a screenshot, a mock-up, an attached file or a link, retype the ask in a sentence.',
    },
    {
      title: 'Check the SOW wording it compares against',
      body: 'Open the project’s **Overview** tab and look at the deliverables and excluded items Guardian holds. Vague names produce vague verdicts.',
      details: [
        'Guardian compares deliverable names only. Descriptions, dates, revision limits, assumptions and payment terms are not part of the comparison.',
        'Use the **Adjust wording** pencil only to fix a typo. Real changes to scope go through a change order.',
      ],
    },
  ],
  dos: [
    'Paste a single, self-contained request in the client’s own words.',
    'Include the specific thing asked for, such as “add a blog section”, not just “as discussed”.',
    'Keep deliverable names in the SOW specific.',
    'List anything you know you will not do in **Out of scope**.',
  ],
  donts: [
    'Do not paste a whole email chain or a 40-message thread.',
    'Do not paste images, “see attached” or a link and expect Guardian to open it.',
    'Do not expect Guardian to know what was said on a call or agreed verbally.',
    'Do not paste the same text again to get a different verdict. Identical or near-identical text is skipped.',
  ],
  problems: [
    {
      symptom: '“Content is too long … Paste at most 20,000 — the request itself, not the whole thread.”',
      meaning: 'Pasted text is limited to 20,000 characters. Forwarded emails are cut off at the same length, keeping the start.',
      fix: 'Paste only the latest request.',
    },
    {
      symptom: 'My long thread came back **Duplicate of a recent check — skipped**, but it has a new request in the middle',
      meaning: 'To spot duplicates, Guardian compares only the first and last 1,000 characters or so of each message. A longer version of a thread you already checked starts and ends the same, so it looks like a repeat. The middle is not compared.',
      fix: 'Paste just the new message. It will be checked as a fresh request.',
    },
    {
      symptom: 'The verdict is **Borderline** and the reason mentions both covered and new work',
      meaning: 'The text matched a signed deliverable and also looked like extra work, which is common with mixed threads.',
      fix: 'Read **View original request**, then **Confirm out of scope** or **Dismiss**. Next time paste the requests separately.',
    },
    {
      symptom: 'It said **In scope** for something that is clearly extra',
      meaning: 'A deliverable name covers it too broadly, or the thing was never listed under Out of scope. Guardian also cannot see attachments or verbal agreements.',
      fix: 'Draft a change order if the work is extra, and tighten the deliverable names in your next SOW.',
    },
    {
      symptom: 'It said **Out of scope** for something you already agreed',
      meaning: 'The agreement may only exist in an email, call or attachment, or in a change order that was never accepted.',
      fix: 'Dismiss the flag if it is Needs review, or Close it with a reason. Get agreed extras into a change order so Guardian knows about them.',
    },
    {
      symptom: 'A message was skipped and nothing was recorded',
      meaning: 'Emails from automatic senders, text under 8 characters, or only-quoted replies are ignored without a record.',
      fix: 'Paste the real text into the paste box.',
    },
  ],
  whatHappensNext: [
    'Each submission gets a single verdict, and one flag at most.',
    'Duplicates are matched only against checks from the last 30 days, and only since the scope last changed. After a signed SOW or an accepted change order, nothing before it counts as a duplicate.',
    'When a change order is accepted, its deliverables are added to what Guardian treats as in scope, so a similar request is recognised next time as covered.',
  ],
  related: ['check-client-message-verdict', 'forward-client-emails-to-guardian', 'what-guardian-does'],
  updated: '2026-10-29',
}

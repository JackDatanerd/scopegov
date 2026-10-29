// lib/help/articles/check-client-message-verdict.ts
// Checked against the product code on 2026-10-29: app/api/guardian/check, lib/ai/guardian.ts (thresholds, outcomes),
// GuardianTab, VERDICT_COPY and GuardianHistoryPanel in ProjectDetail, SettingsClient (Guardian settings).

import type { HelpArticle } from '../types'

export const checkClientMessageVerdict: HelpArticle = {
  slug: 'check-client-message-verdict',
  title: 'How do I check a client’s message, and what does the verdict mean?',
  summary: 'Paste a client message into a project’s Guardian tab, then read the verdict, the matched deliverable and the confidence figure.',
  category: 'guardian',
  order: 2,
  audience: { permissions: ['SUBMIT_GUARDIAN_CHECKS'], plan: 'all' },
  shortAnswer:
    'Open the project’s **Guardian** tab, click **Paste email or message**, paste the client’s request and click **Check scope**. ' +
    'A card tells you whether it is in scope, covered by an accepted change order, borderline or out of scope, which deliverable it matched, and how confident Guardian is that it is new work. ' +
    'Borderline and out-of-scope results also create a flag below.',
  beforeYouStart: [
    'A project with a signed SOW. Its status is **Active** (or paused).',
    'The client’s message as text, ideally just the request itself.',
  ],
  steps: [
    {
      title: 'Open the Guardian tab',
      body: 'Open the project and click its **Guardian** tab. The top line says **Guardian active** when it is monitoring.',
    },
    {
      title: 'Paste the message',
      body: 'Click **Paste email or message**, paste the client’s text into the box, and click **Check scope**.',
      details: [
        'Paste at most 20,000 characters. Longer text is refused.',
        'Pasted HTML is converted to plain text for you.',
        'If the button reads **Log a past check** instead, the project is not live (not signed yet, or Complete or Archived). The text is recorded for the record and marked **Retroactive**.',
      ],
      watchFor: 'Paste only the request. Pasting a whole thread makes the verdict unreliable (see “Why did Guardian skip, misjudge or flag my pasted thread?”).',
    },
    {
      title: 'Read the result card',
      body: 'The card shows the verdict title, **Matched against** (the deliverable or change order it judged the request closest to), and **Creep confidence** as a percentage.',
      details: [
        '**In scope — no action needed**: it matches a signed deliverable. No flag.',
        '**Covered by an accepted change order**: it matches work the client already bought. No flag.',
        '**Borderline — flagged for human review**: Guardian is unsure, or the message mixes covered and new work. A flag with status **Needs review** is created.',
        '**Out of scope — flag created below**: it looks like new work. An **Open** flag is created.',
        '**Duplicate of a recent check — skipped**: it closely resembles something checked in the last 30 days. Nothing new is created.',
        '**No signed SOW yet** or **Saved — will be checked automatically**: it is stored and checked later.',
      ],
    },
    {
      title: 'Act on the flag',
      body: 'A flag appears under the card within a couple of seconds. Open it and choose what to do next.',
      watchFor: 'You are not emailed about a flag you created yourself, but your teammates with Approve flags are.',
    },
  ],
  dos: [
    'Check each new request as it arrives, while the client’s wording is fresh.',
    'Open the flag’s **View original request** later to see exactly what was checked.',
    'Use **Check history** to confirm that a message was recorded.',
    'Adjust the **Sensitivity tier** in **Settings**, then **Guardian settings**, if flags are too frequent or too rare.',
  ],
  donts: [
    'Do not read the confidence percentage as a precise measurement. It is Guardian’s estimate.',
    'Do not paste your own replies or internal notes. Only the client’s request belongs here.',
    'Do not paste the same message twice to “try again”. It will be skipped as a duplicate.',
    'Do not edit the SOW’s wording just to change a verdict. Real scope changes go through a change order.',
  ],
  problems: [
    {
      symptom: 'There is no **Paste email or message** button',
      meaning: 'You need the Submit Guardian checks permission, and the project must be Active or paused.',
      fix: 'Ask an admin for the permission. On a project that is not live, use **Log a past check**.',
    },
    {
      symptom: '“Content is too long … Paste at most 20,000”',
      meaning: 'The text is over the limit.',
      fix: 'Paste only the client’s latest request, not the whole thread.',
    },
    {
      symptom: 'The card says **Classification failed — try again in a moment**',
      meaning: 'Guardian could not reach a verdict, for example because the AI service was busy. The message is saved.',
      fix: 'It is retried automatically. Or open **Check history** and click **Retry classification**.',
    },
    {
      symptom: 'The card says **Duplicate of a recent check — skipped**',
      meaning: 'A very similar message was checked within the last 30 days. Checks from before the scope last changed (a signed SOW, an accepted change order or a wording adjustment) do not count.',
      fix: 'Look in **Check history** for the earlier result. If this is genuinely a new request, paste just the new wording.',
    },
    {
      symptom: 'It says **In scope** but the client is clearly asking for extra work',
      meaning: 'A deliverable name in your SOW is broad enough to cover it, or the request was not on the Out of scope list.',
      fix: 'Judge it yourself. If it is extra, draft a change order. For next time, write more specific deliverable names.',
    },
    {
      symptom: 'The card says the project is complete and the verdict was recorded only',
      meaning: 'On a Complete or Archived project Guardian records the verdict but raises no flag and tells nobody.',
      fix: 'Reopen the project if the work is continuing.',
    },
  ],
  whatHappensNext: [
    'Every check is stored under **Check history** with its verdict and a **Retroactive** badge where relevant.',
    'Out of scope and borderline results become flags. Everything else leaves no flag.',
    'Out-of-scope flags email your team members who can approve flags. Borderline flags notify them in the app only.',
    'Out of scope is flagged once Guardian’s confidence is high enough. Medium sensitivity flags from 85%, Conservative from 92%, Aggressive from 78%. Borderline starts lower, at 60%, 75% and 55% respectively.',
  ],
  related: ['what-guardian-does', 'understand-flag-statuses', 'guardian-good-bad-inputs'],
  updated: '2026-10-29',
}

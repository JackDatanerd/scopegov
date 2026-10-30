// lib/help/articles/sessions-where-youre-signed-in.ts
//
// Checked 2026-10-30 against: components/settings/SessionsSection.tsx, app/api/auth/sessions/*, app/api/auth/signout-others/route.ts,
// lib/auth/session-seen.ts (new-device alerts), app/api/auth/{change-password,mfa/*}/route.ts (which actions sign other devices out).

import type { HelpArticle } from '../types'

export const sessionsWhereYoureSignedIn: HelpArticle = {
  slug: 'sessions-where-youre-signed-in',
  title: 'How do I see where I\u2019m signed in, and sign out other devices?',
  summary: 'Check the devices signed in to your account, end the ones you do not recognise, and know what else signs devices out.',
  category: 'integrations-security',
  order: 10,
  audience: { permissions: [], plan: 'all' },
  shortAnswer:
    'Open [Settings](/settings), go to **Account**, and look at **Sessions**. Each row is a browser signed in to your account. Click **Sign out** on one you do not recognise, or **Sign out of all other sessions** to keep only the device you are on. ' +
    'If anything looks wrong, also change your password.',
  steps: [
    {
      title: 'Open your sessions',
      body: 'In [Settings](/settings), open the **Account** tab and scroll to **Sessions**. It lists where your account is signed in right now.',
      details: [
        'Each row shows the browser and system, such as \u201cChrome on Windows\u201d, the IP address, when it was last active and when it signed in.',
        'Your current device is marked **This device**.',
        '\u201c2-step verified\u201d appears on sessions that completed two-factor.',
        'The location is the network\u2019s IP address, not a street address. A phone on mobile data can appear to be somewhere else.',
      ],
    },
    {
      title: 'Sign out one session',
      body: 'Click **Sign out** on that row. You see \u201cSession signed out.\u201d',
      details: [
        'That device is asked to sign in again the next time it opens ScopeGov.',
        'There is no **Sign out** button on your current device. Use the normal sign-out for that.',
      ],
    },
    {
      title: 'Sign out everywhere else',
      body: 'Click **Sign out of all other sessions**. You see \u201cSigned out of all other sessions. This device stays signed in.\u201d',
    },
    {
      title: 'If a session looks unfamiliar',
      body: 'Sign it out first, then change your password in the same **Account** tab, under **Change password**.',
      details: [
        'If you use two-factor, regenerate your backup codes too.',
        'Tell your workspace owner if the account has access to client or financial data.',
      ],
    },
  ],
  dos: [
    'Look at **Sessions** after travelling, using a shared computer or losing a device.',
    'Sign out sessions on borrowed machines when you are done.',
    'Keep two-factor on, so a stolen password alone is not enough.',
    'Take new-device emails seriously.',
  ],
  donts: [
    'Do not stay signed in on a shared computer.',
    'Do not assume a session you do not recognise is a glitch. A browser update can change its name, but check.',
    'Do not sign out others and skip the password change if you suspect someone has it.',
    'Do not rely on a teammate to sign you out. Only you can.',
  ],
  problems: [
    {
      symptom: 'The list says \u201cNo other information available.\u201d',
      meaning: 'ScopeGov could not load session details. Your account is not affected.',
      fix: 'Reload the page. If it persists, use **Sign out of all other sessions**, which does not depend on the list.',
    },
    {
      symptom: '**Sign out of all other sessions** is greyed out',
      meaning: 'There are no other sessions to end.',
      fix: 'Nothing to do.',
    },
    {
      symptom: '\u201cThat\u2019s the session you\u2019re using now. Use Sign out instead.\u201d',
      meaning: 'You tried to end your own session from the list.',
      fix: 'Use the normal sign-out.',
    },
    {
      symptom: 'You get an email or notification about a sign-in from a new device',
      meaning: 'Your account was used from a browser and system ScopeGov had not seen for you in the last 90 days, shortly after sign-in.',
      fix: 'If it was you, ignore it. If not, sign that session out, change your password and check two-factor.',
    },
    {
      symptom: 'A device was signed out and you did not do it',
      meaning: 'Other devices are signed out when you or an admin change your password, turn two-factor on or off, use a backup code, or reset your two-factor.',
      fix: 'Sign in again. Check the audit log, or ask an owner, if you are unsure who did it.',
    },
  ],
  whatHappensNext: [
    'A signed-out device must enter its password (and code) again.',
    'Signing out a session does not change your password or your two-factor setup.',
    'New sessions appear in the list as soon as the device signs in.',
  ],
  related: ['password-reset-and-change', 'mfa-set-up-two-factor', 'mfa-lost-phone-or-backup-codes', 'legal-pages-in-plain-language'],
  updated: '2026-10-30',
}

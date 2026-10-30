// lib/help/articles/mfa-lost-phone-or-backup-codes.ts
//
// Checked 2026-10-30 against: app/mfa-challenge/page.tsx, components/mfa/MfaSetupClient.tsx (recovered banner), app/api/auth/mfa/recover/route.ts,
// app/api/team/[id]/reset-mfa/route.ts, components/team/TeamClient.tsx (Reset MFA), lib/auth/{mfa-reset-authority,attempt-limit}.ts, lib/utils/{backup-codes,owner-protection}.ts.

import type { HelpArticle } from '../types'

export const mfaLostPhoneOrBackupCodes: HelpArticle = {
  slug: 'mfa-lost-phone-or-backup-codes',
  title: 'I lost my phone or my authenticator code. How do I get back in?',
  summary: 'Use a backup code, or ask a teammate to reset your two-factor, and understand what each route changes.',
  category: 'integrations-security',
  order: 8,
  audience: { permissions: [], plan: 'all' },
  shortAnswer:
    'On the sign-in code page, click **Use a backup code instead** and enter one of the codes you saved. That signs you in, removes your old authenticator and asks you to set up a new one. ' +
    'With no backup codes, ask a teammate with the Manage Roles permission to click **Reset MFA** on your card in the Team page. The workspace owner has no teammate who can do that, so owners should contact support.',
  beforeYouStart: [
    'Your password. Both routes start with a normal sign-in.',
    'Either one unused backup code, or a teammate who holds Manage Roles.',
  ],
  steps: [
    {
      title: 'If you have a backup code',
      body: 'Sign in with your password. On the page headed **Enter your code**, click **Use a backup code instead**. Type a code in the **Backup code** box and click **Recover access**.',
      details: [
        'A code looks like two groups of six letters and numbers joined by a dash. Letters you type are turned into capitals for you.',
        'Each code works once.',
        'Five wrong codes in five minutes pause attempts for a few minutes. ScopeGov may email you about it.',
      ],
    },
    {
      title: 'Know what recovery changes',
      body: 'Recovery is deliberately blunt, because someone holding a code could be anyone. When it works:',
      details: [
        'Your old authenticator is removed.',
        'Every other backup code is cancelled, not just the one you used.',
        'You are signed out of all your other devices.',
        'You get an email saying two-factor was reset using a backup code, and the audit log records it.',
      ],
      watchFor: 'If you did not do this, someone else may have your backup codes. Change your password straight away.',
    },
    {
      title: 'Set up a new authenticator',
      body: 'You land on the setup page with a note that your previous authenticator was reset. Scan the new QR code, enter the code, and save the new backup codes.',
      details: [
        'The steps are the same as in the setup article.',
        'Your old codes no longer work, so the new set is the only one.',
      ],
    },
    {
      title: 'If you have no backup codes',
      body: 'Ask a teammate who holds Manage Roles to open the [Team](/team) page, find your card, and click **Reset MFA**, then confirm.',
      details: [
        'They are asked to confirm it is them. It removes your authenticator and signs you out of every device.',
        'Next time you sign in, you set up two-factor again where your role calls for it.',
        'You cannot reset your own: the **Reset MFA** button does not appear on your own card.',
      ],
    },
    {
      title: 'If you are the workspace owner, or the reset is refused',
      body: 'A teammate cannot reset the owner\u2019s two-factor, and cannot reset someone who holds permissions they do not hold themselves.',
      details: [
        'They see \u201cThis person is the workspace owner, so their access can\u2019t be changed by anyone else.\u201d',
        'If you also belong to another workspace they do not manage, they see that two-factor protects your access there too, and that you should recover with a backup code or contact ScopeGov support.',
        'Email support@scopegov.app from the address on your account.',
      ],
    },
    {
      title: 'Replacing a phone you still have',
      body: 'Sign in on the old phone\u2019s authenticator, open [Settings](/settings), **Account**, click **Disable two-factor authentication** and confirm with **Yes, disable**. Then click **Set up two-factor authentication** on the new phone.',
      details: [
        'Disabling signs you out of other devices and cancels unused backup codes. The new setup gives you fresh ones.',
        'Where your role requires two-factor and the workspace enforces it, the disable button is unavailable. Use a backup code instead.',
      ],
    },
  ],
  dos: [
    'Use a backup code the moment you notice the phone is gone.',
    'Set up the new authenticator immediately after recovery.',
    'Store the new backup codes away from the phone.',
    'Tell your workspace owner if your account may be exposed.',
  ],
  donts: [
    'Do not keep trying wrong codes. Five misses lock you for minutes.',
    'Do not send a backup code to anyone, including support. Nobody needs it.',
    'Do not ask someone with fewer permissions than you to reset you. It is refused.',
    'Do not ignore a \u201ctwo-factor reset\u201d email you did not expect.',
  ],
  problems: [
    {
      symptom: '\u201cThat backup code is invalid or has already been used.\u201d',
      meaning: 'The code was mistyped, has been used, or was cancelled when you regenerated or disabled.',
      fix: 'Check each character. Try another code. If none work, ask a teammate for a reset.',
    },
    {
      symptom: '\u201cToo many incorrect attempts. Try again in N minutes.\u201d',
      meaning: 'The limit is five failures in five minutes.',
      fix: 'Wait the time shown, then try a different code carefully.',
    },
    {
      symptom: '\u201cRecovery could not be completed. Your backup code was not used \u2014 please try again.\u201d',
      meaning: 'A temporary fault stopped it, and ScopeGov gave the code back.',
      fix: 'Try again in a minute.',
    },
    {
      symptom: '\u201cNo verified authenticator found on this account. Contact your workspace owner.\u201d',
      meaning: 'The sign-in page found no authenticator to check, usually because it was reset elsewhere.',
      fix: 'Sign out and sign in again. If it persists, ask for a reset.',
    },
    {
      symptom: 'There is no **Reset MFA** button on a teammate\u2019s card',
      meaning: 'You lack Manage Roles, the card is your own, the invitation has not been accepted, or the person has no two-factor set up.',
      fix: 'Check your permissions, or ask an owner.',
    },
    {
      symptom: '\u201cCannot reset MFA for a member who holds permissions you don\u2019t hold yourself\u201d',
      meaning: 'You can only reset someone whose permissions are within your own.',
      fix: 'Ask someone with at least those permissions, such as an owner.',
    },
  ],
  whatHappensNext: [
    'After recovery or a reset you sign in with your password and are taken to set up two-factor again.',
    'The audit log records who reset or recovered two-factor, and when.',
    'Other devices stay signed out until you sign in on them again.',
  ],
  related: ['mfa-set-up-two-factor', 'sessions-where-youre-signed-in', 'password-reset-and-change', 'custom-roles-and-mfa'],
  updated: '2026-10-30',
}

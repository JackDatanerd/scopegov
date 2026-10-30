// lib/help/articles/mfa-set-up-two-factor.ts
//
// Checked 2026-10-30 against: components/settings/MfaSection.tsx, components/mfa/MfaSetupClient.tsx, app/mfa-challenge/page.tsx,
// app/api/auth/mfa/{enroll,verify,factors,backup-codes}/route.ts, lib/auth/{mfa-policy,step-up,attempt-limit}.ts, lib/utils/backup-codes.ts.

import type { HelpArticle } from '../types'

export const mfaSetUpTwoFactor: HelpArticle = {
  slug: 'mfa-set-up-two-factor',
  title: 'How do I set up two-factor authentication?',
  summary: 'Add an authenticator app as a second sign-in step, and save the backup codes that rescue you if the phone is lost.',
  category: 'integrations-security',
  order: 7,
  audience: { permissions: [], plan: 'all' },
  shortAnswer:
    'Open [Settings](/settings), go to the **Account** tab, and click **Set up two-factor authentication**. Scan the QR code with an authenticator app, type the 6-digit code it shows, and save the eight backup codes you are given. ' +
    'From then on, signing in asks for your password and a fresh code from the app.',
  beforeYouStart: [
    'An authenticator app on your phone or computer. Google Authenticator, 1Password, Authy or any app that makes 6-digit TOTP codes will do.',
    'Somewhere safe to keep eight backup codes that is not the same device as your authenticator.',
    'A recent sign-in. If you signed in a while ago, ScopeGov asks you to sign in again first and brings you straight back.',
  ],
  steps: [
    {
      title: 'Start from your account settings',
      body: 'Open [Settings](/settings), go to **Account**, and find **Two-factor authentication**. Click **Set up two-factor authentication**.',
      details: [
        'The badge next to the heading tells you where you stand: **Off**, **Recommended** or **Required, not set up**. **Enabled** means you already have it.',
        'People who can see sensitive data, such as prices, client details, billing or approvals, are told two-factor is recommended, and in some workspaces it is required.',
      ],
    },
    {
      title: 'Scan the QR code',
      body: 'On the page titled **Scan with your authenticator app**, scan the QR code with your app.',
      details: [
        'Cannot scan? Under the code, \u201cCan\u2019t scan? Enter manually\u201d gives a text key you can type into the app.',
        'If you are asked to **Confirm it\'s you**, click **Sign in again**. You return to this page afterwards.',
      ],
    },
    {
      title: 'Type the code',
      body: 'Enter the 6-digit code from your app under **Enter the 6-digit code from your app**, then click **Verify and enable**.',
      details: [
        'Codes change every 30 seconds or so. If one is rejected, wait for the next and try again.',
        'Too many wrong codes in a row lock you out for a few minutes.',
      ],
    },
    {
      title: 'Save your backup codes',
      body: 'On **Save your backup codes**, copy the eight codes with **Copy all codes**, store them somewhere safe, tick \u201cI\u2019ve saved these backup codes somewhere safe\u201d and click **Continue**.',
      details: [
        'Each code works once. They are shown only now.',
        'Turning two-factor on signs you out of every other device. Your current one stays signed in.',
        'You also get an email telling you two-factor is on.',
      ],
      watchFor: 'If the codes are not shown, click **Generate backup codes**. Do not rely on two-factor until you have a set.',
    },
    {
      title: 'Sign in the new way',
      body: 'Next time you sign in, enter your password. A page headed **One more step** asks for **Enter your code**. Open your app and type the 6-digit code, then click **Verify**.',
    },
    {
      title: 'Manage it later',
      body: 'In **Account**, under **Two-factor authentication**, you see the date it was enabled and how many backup codes remain.',
      details: [
        '**Regenerate** makes a fresh set of codes. The old ones stop working at once. You may be asked to confirm with a code first.',
        '**Disable two-factor authentication** turns it off after you click **Yes, disable**. It signs you out of other devices and cancels any unused backup codes.',
        'Where your workspace requires two-factor for your role, the disable button is greyed out.',
      ],
    },
  ],
  dos: [
    'Keep backup codes in a password manager or printed in a safe place.',
    'Choose an authenticator app that can back itself up, so a lost phone is not a lost account.',
    'Regenerate your codes when you are down to one or two.',
    'Set it up before you are required to, not after.',
  ],
  donts: [
    'Do not screenshot the backup codes to the same phone as your authenticator.',
    'Do not share a code with anyone, including someone claiming to be support.',
    'Do not disable two-factor to \u201cget in faster\u201d. A backup code is faster.',
    'Do not keep using old codes after regenerating. They no longer work.',
  ],
  problems: [
    {
      symptom: '\u201cIncorrect code. Check your authenticator app and try again.\u201d',
      meaning: 'The code was wrong or expired, or your phone\u2019s clock is out of step.',
      fix: 'Wait for the next code and retry. Set your phone\u2019s clock to automatic if it keeps failing.',
    },
    {
      symptom: '\u201cToo many incorrect attempts. Try again in N minutes.\u201d',
      meaning: 'Five wrong codes within five minutes pause attempts as a precaution. ScopeGov may email you about it.',
      fix: 'Wait the time shown, then try again with a fresh code.',
    },
    {
      symptom: '**Two-factor authentication is already on**',
      meaning: 'You already have an authenticator. Only one can be active.',
      fix: 'Click **Continue**. To change phone, use the lost or replaced phone article.',
    },
    {
      symptom: '**Confirm it\'s you**',
      meaning: 'Setting up two-factor needs a sign-in from the last few minutes.',
      fix: 'Click **Sign in again**, then carry on.',
    },
    {
      symptom: 'The **Regenerate** button asks for a code first, or says \u201cRe-verify your authenticator code\u201d',
      meaning: 'Making new backup codes needs a recent code from your app.',
      fix: 'Confirm with your authenticator code when asked, or sign out and sign in again, then retry.',
    },
    {
      symptom: 'The disable button is greyed out',
      meaning: 'Your workspace requires two-factor for your permissions.',
      fix: 'Ask an owner to change your permissions first. See the roles and permissions articles.',
    },
  ],
  whatHappensNext: [
    'From now on every sign-in needs your password and a code.',
    'Each time someone resets, disables or recovers two-factor on your account, you are emailed and the audit log records it.',
    'Using a backup code later removes your authenticator, signs out your other devices and asks you to set up again.',
  ],
  related: ['mfa-lost-phone-or-backup-codes', 'sessions-where-youre-signed-in', 'password-reset-and-change', 'custom-roles-and-mfa'],
  updated: '2026-10-30',
}

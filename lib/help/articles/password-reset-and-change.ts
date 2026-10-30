// lib/help/articles/password-reset-and-change.ts
//
// Checked 2026-10-30 against: app/(auth)/login/LoginForm.tsx (Forgot?), app/(auth)/forgot-password/page.tsx, app/(auth)/reset-password/page.tsx,
// app/api/auth/{reset-password,change-password,validate-password}/route.ts, lib/auth/{password-policy,attempt-limit}.ts, components/settings/SettingsClient.tsx (Change password).

import type { HelpArticle } from '../types'

export const passwordResetAndChange: HelpArticle = {
  slug: 'password-reset-and-change',
  title: 'I forgot my password, or I want to change it. What do I do?',
  summary: 'Reset a forgotten password from the sign-in page, or change a known one in Settings, and know what each does to your other devices.',
  category: 'integrations-security',
  order: 9,
  audience: { permissions: [], plan: 'all' },
  shortAnswer:
    'Forgotten: on the sign-in page click **Forgot?**, enter your email and click **Send reset link**, then open the link in the email and choose a new password. ' +
    'Known: open [Settings](/settings), go to **Account**, and use **Change password**. Either way, every other device you were signed in on is signed out.',
  beforeYouStart: [
    'Access to the email inbox for your ScopeGov account. The reset link goes only there.',
    'If you use two-factor, your authenticator app or a backup code. A reset does not skip it.',
  ],
  steps: [
    {
      title: 'Ask for a reset link',
      body: 'On the sign-in page, click **Forgot?** next to the password box. Under **Reset your password**, type your **Email address** and click **Send reset link**.',
      details: [
        'You see \u201cCheck your inbox\u201d. It says the same whether or not the address has an account, so nobody can use the page to find out who has one.',
        'The email can take a few minutes. Check spam.',
        'Too many requests in a short time show \u201cToo many reset requests. Please wait a few minutes before trying again.\u201d',
      ],
    },
    {
      title: 'Open the link',
      body: 'Click the link in the email. It opens a page headed **Set new password**.',
      details: [
        'A link works once. Opening it a second time, or after it has expired, shows **Reset link expired**.',
        'After you open it, you have about 15 minutes to finish choosing a password. After that, request a new link.',
        'If you have two-factor on, you are asked for your code before the new password is saved.',
      ],
    },
    {
      title: 'Choose a new password',
      body: 'Type it under **New password** and again under **Confirm new password**, then click **Update password**.',
      details: [
        'At least 8 characters, and no more than 72 bytes.',
        'Not a very common password, not one repeated character, and not your email address or the part before the @.',
        'You see **Password updated** and click **Sign in**. All your earlier sessions are signed out and you get an email saying the password changed.',
      ],
    },
    {
      title: 'If you know your password and want a new one',
      body: 'Open [Settings](/settings), go to **Account**, and find **Change password**. Fill in **Current password**, **New password** and **Confirm new password**, then click **Update password**.',
      details: [
        'Your other devices are signed out. This device stays signed in.',
        'If you use two-factor, you may be asked to re-enter an authenticator code first.',
        'If you signed up with Google and have no password yet, there is no current password to type. Setting one needs a recent sign-in.',
      ],
    },
    {
      title: 'Sign in with the new password',
      body: 'Sign in on each device you still want to use.',
    },
  ],
  dos: [
    'Use a password manager and a password you use nowhere else.',
    'Change your password at once if you suspect someone else has it, then check your sessions.',
    'Read the \u201cpassword changed\u201d email. If it was not you, act immediately.',
    'Reset through the link, not by asking a teammate. Nobody else can set your password.',
  ],
  donts: [
    'Do not forward the reset email.',
    'Do not keep opening an old link. It is single-use.',
    'Do not use your email address, your agency name or \u201cscopegov\u201d in the password.',
    'Do not reuse a password from another service.',
  ],
  problems: [
    {
      symptom: 'No reset email arrives',
      meaning: 'The address may be wrong, the message may be in spam, or it has not arrived yet.',
      fix: 'Wait a few minutes, check spam, and try the address you signed up with. Then request again.',
    },
    {
      symptom: '**Reset link expired**',
      meaning: 'The link was already used, has expired, or was opened in a way that could not be verified.',
      fix: 'Click **Request a new link** and use the newest email. Older links stop working once a newer one is used.',
    },
    {
      symptom: '\u201cThis reset session has expired. Request a new reset link, or change your password from Settings while signed in.\u201d',
      meaning: 'You opened the link but took longer than about 15 minutes to submit a password.',
      fix: 'Request a new link and finish straight away.',
    },
    {
      symptom: '\u201cThat password is too common\u201d, \u201cYour password can\u2019t be your email address\u201d, or \u201cPassword must be at least 8 characters\u201d',
      meaning: 'The new password breaks one of the rules.',
      fix: 'Choose a longer, less guessable password. A few unrelated words works well.',
    },
    {
      symptom: '\u201cCurrent password is incorrect\u201d',
      meaning: 'The current password you typed in **Account** was wrong. Repeated failures pause attempts for a few minutes.',
      fix: 'Try again carefully, or sign out and use **Forgot?**.',
    },
    {
      symptom: '\u201cThis page is only for password-reset links. To change your password while signed in, use Settings \u2192 Account.\u201d',
      meaning: 'You opened the reset page while signed in normally. It only works straight from a reset email.',
      fix: 'Use **Change password** in **Account**.',
    },
    {
      symptom: '\u201cVerify your authenticator code to continue\u201d',
      meaning: 'Your account has two-factor, and a reset still needs it.',
      fix: 'Enter the code from your app. With no phone, see the lost phone article.',
    },
  ],
  whatHappensNext: [
    'Your password changes straight away and a confirmation email goes to your address.',
    'Other devices are signed out. The next time they open ScopeGov they ask for the new password.',
  ],
  related: ['sessions-where-youre-signed-in', 'mfa-set-up-two-factor', 'mfa-lost-phone-or-backup-codes', 'legal-pages-in-plain-language'],
  updated: '2026-10-30',
}

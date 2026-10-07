# Branded Supabase Auth email templates

Supabase hosts auth emails, so these cannot ship with a deploy. Paste each file into
**Supabase Dashboard -> Authentication -> Emails -> Templates** (all on the same page):

| File | Template | Suggested subject |
|---|---|---|
| confirm-signup.html | Confirm signup | Confirm your ScopeGov email |
| reset-password.html | Reset password | Reset your ScopeGov password |
| magic-link.html | Magic link | Your ScopeGov sign-in link |
| change-email.html | Change email address | Confirm your new ScopeGov email |
| invite.html | Invite user | You've been invited to ScopeGov |
| reauthentication.html | Reauthentication | Your ScopeGov confirmation code |

Confirm-signup and reset-password already use the token-hash links from README section 1.3, so they
work when opened on another device. Also set **Authentication -> SMTP -> Sender name** to `ScopeGov`
so the From line is branded too.

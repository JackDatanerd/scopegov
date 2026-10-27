# ScopeGov for Slack

Posts ScopeGov events (scope flags, signed SOWs, change-order answers, payments, overdue invoices…) into Slack channels
you choose, each with the project, client, document number, amounts and an **Open in ScopeGov** button.
Pro plan and above. Code: `lib/integrations/slack*.ts`, `app/api/integrations/slack/callback`, `app/api/workspace/integrations/slack/*`.

## One-time setup (needs your Slack account — the repo cannot do this)
1. https://api.slack.com/apps → **Create New App → From an app manifest** → pick your workspace → paste
   `manifest.json`. **Edit `redirect_urls` first** if your app is not served from `https://scopegov.app` — it must equal
   `${NEXT_PUBLIC_APP_URL}/api/integrations/slack/callback` exactly.
2. App → **Basic Information** → copy **Client ID** and **Client Secret**.
3. Set in Vercel: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` (and `INTEGRATIONS_ENCRYPTION_KEY`, `NEXT_PUBLIC_APP_URL` if not yet set). Redeploy.
4. Run migration **167**.
5. In ScopeGov: Settings → Integrations → Slack → **Add to Slack** (as a Pro workspace, as someone with
   "Manage workspace settings"). Pick a channel and the events to post; "Send test" posts within about a minute.

Until step 5 works for any customer, install the app in your OWN Slack workspace to test. To let OTHER workspaces
install it, the app needs **Manage Distribution → Activate Public Distribution** (Slack runs a short checklist) and, to
appear in the Slack App Directory, Slack's app review. Distribution itself does not need the directory.

## What it asks Slack for, and why
`chat:write` post messages · `chat:write.public` post to public channels without being invited · `channels:read` and
`groups:read` list channels for the picker (private channels only if the app was invited). It cannot read messages.

## Behaviour worth knowing
- One rule per channel; a rule is a list of events. The person adding a rule must themselves hold the permission each
  event needs (same rule as webhooks).
- Text written by a CLIENT (a decline reason, a dispute note) is escaped so it cannot `@channel`, mention anyone or forge a link.
- If the token is revoked (app removed from Slack) the next post flags the connection and switches every rule off; Settings
  then offers **Reconnect**, and reconnecting to the SAME Slack workspace switches those rules back on.
- Low-confidence Guardian "borderline" items are not posted until someone confirms them (same as email).
- Not built: buttons that act from inside Slack (approve/dismiss a flag), and a channel auto-created per project. Both need
  Slack-user ↔ ScopeGov-user identity mapping (a security design of its own) and extra scopes.

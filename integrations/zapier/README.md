# ScopeGov for Zapier

The Zapier-side app definition. Server side lives in `app/api/integrations/v1/*` and `lib/integrations/zapier.ts`.

- **Auth:** workspace API key (Settings → Integrations → API keys). Zapier tests it against `GET /api/integrations/v1/me`.
- **Triggers:** one REST-hook trigger per event in `lib/integrations/event-catalog.ts` (19 today). `events.json` is generated;
  run `node --experimental-strip-types scripts/gen-zapier-events.mjs` from the repo root after changing the catalog
  (a test fails if it drifts).
- **Plan:** Starter and above. Subscribing needs the event's permission held by the API key's creator.

## Ship it (needs your Zapier developer account — not something the repo can do)
Needs **Node.js 22+** (Zapier's CLI requirement).
```
cd integrations/zapier && npm install
npm install -g zapier-platform-cli
zapier login                         # opens a browser; sign in to your Zapier developer account
zapier register "ScopeGov"           # once: creates the integration (use `zapier link` if it already exists in the web UI)
zapier push                          # uploads this code as version 1.0.0 — PRIVATE
zapier invite you@example.com        # or: zapier users:add — private testers get an invite link
```
**Public listing** is requested in the web UI, even for CLI-built integrations: https://developer.zapier.com → your integration → **Publish**
→ complete the checklist → **Submit for Review**. Zapier replies in about a week; a public **beta** phase (about 90 days) follows before it is fully
public. Before you can submit, Zapier's checks need (among other things) **at least 3 users with a live Zap** on the integration, branding
(logo + description), a help article, and ScopeGov itself fully launched (not invite-only/beta). **You do not have to go public**: a private
integration owned by the API's own company may stay invite-only indefinitely, and customers can use it through your invite link.
Set `SCOPEGOV_API_BASE` only to point at a staging server. Until the integration is public (or you decide to stay private), the Zapier row in
Settings says "App listing pending".

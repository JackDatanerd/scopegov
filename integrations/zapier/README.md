# ScopeGov for Zapier

The Zapier-side app definition. Server side lives in `app/api/integrations/v1/*` and `lib/integrations/zapier.ts`.

- **Auth:** workspace API key (Settings → Integrations → API keys). Zapier tests it against `GET /api/integrations/v1/me`.
- **Triggers:** one REST-hook trigger per event in `lib/integrations/event-catalog.ts` (19 today). `events.json` is generated;
  run `node --experimental-strip-types scripts/gen-zapier-events.mjs` from the repo root after changing the catalog
  (a test fails if it drifts).
- **Plan:** Starter and above. Subscribing needs the event's permission held by the API key's creator.

## Ship it (needs your Zapier developer account — not something the repo can do)
```
cd integrations/zapier && npm install
npx zapier-platform-cli login        # or: npm i -g zapier-platform-cli
npx zapier register "ScopeGov"       # once
npx zapier push                      # uploads a private version
npx zapier invite you@example.com    # share with testers; "zapier promote" + review to list it publicly
```
Set `SCOPEGOV_API_BASE` only to point at a staging server. Until the app is promoted and approved, the Zapier row in
Settings says "App listing pending".

# ScopeGov → HubSpot CRM sync

One-way (ScopeGov → HubSpot). When a SOW is signed ScopeGov creates — or links to — the client's **Company** and **Contact** and a
**Closed-won Deal**, then adds change orders, scope flags and payments to the deal's **timeline** as notes. A declined SOW makes the
deal **Closed-lost**. Pro plan and above.
Code: `lib/integrations/hubspot*.ts`, `lib/integrations/external-refs.ts`, `app/api/integrations/hubspot/callback`, `app/api/workspace/integrations/hubspot/*`.

## What it does and does NOT do
| ScopeGov | HubSpot |
|---|---|
| Client with a **company name** | Company — linked to an EXISTING company with the same name (oldest), else created |
| Client with an **email** | Contact — linked to an EXISTING contact with that email, else created |
| Project | Deal in the pipeline you choose, associated to the company and contact |
| SOW signed / declined | Deal → that pipeline's **Closed won** / **Closed lost** stage |
| Change order accepted, scope flag raised, payment received | A note on the deal's timeline |

- **It never overwrites your data.** An existing contact or company is linked to and left exactly as it is; only the deals ScopeGov
  itself created are ever edited. Nothing is deleted, ever (disconnecting leaves everything in HubSpot).
- **Amounts are opt-in.** The deal amount (the project's contract value) is sent only if "Send the contract value as the deal amount"
  is switched on, and only by someone who can view financials in ScopeGov. It follows the contract value after accepted change orders.
- **Contact details are only shared by people allowed to see them:** connecting needs `VIEW_CLIENT_DATA`; each event needs the same
  permission as everywhere else in ScopeGov (SOWs: `SEND_SOW`, change orders: `SEND_CHANGE_ORDERS`, flags: `APPROVE_FLAGS`, payments: `VIEW_FINANCIALS`).
- **Idempotent and self-healing.** ScopeGov records what it created, so retries and repeats never duplicate; a deal created just
  before a crash is re-found (same name, created in the last hour); records deleted in HubSpot are recreated on the next event.
- **No custom properties** are added to your HubSpot (no schema scopes). Notes are plain text with HTML escaped.
- "Sync existing projects" backfills projects that already have a signed SOW (200 per click, once per 10 minutes), without timeline noise.
- Not built: two-way sync (HubSpot → ScopeGov), syncing client edits, owners/assignees, line items, quotes, custom properties.

## Create the HubSpot app (HubSpot's CURRENT platform — read this, it changed in 2026)
HubSpot **disabled creating new "legacy public apps" in its UI** (new accounts from 2026-05-26, existing accounts from 2026-06-23). New OAuth
apps are built with HubSpot's **Projects platform and CLI**: there is no "Create app" button. Needs Node.js and the HubSpot CLI.

1. Sign in at https://app.hubspot.com (any standard account; create one free at https://app.hubspot.com/signup-hubspot if you have none).
   Open **Development** in the left nav. Create a **developer test account** (Development → Testing → Test Accounts) to test with.
2. `npm install -g @hubspot/cli@latest` then `hs account auth` (or `hs init`) and sign in.
3. In an empty folder (NOT inside the ScopeGov repo): `hs project create` → choose the **App** template, **Distribution: marketplace**,
   **Authentication: oauth**, and no extra features (no cards / workflow actions).
4. Edit the generated `app-hsmeta.json` (the field names below are what HubSpot's template uses; trust the generated file if yours differ):
   ```json
   {
     "uid": "scopegov",
     "type": "app",
     "name": "ScopeGov",
     "description": "Creates companies, contacts and Closed-won deals from signed SOWs, and logs change orders, scope flags and payments on the deal.",
     "logo": "./logo.png",
     "auth": {
       "type": "oauth",
       "redirectUrls": ["https://scopegov.app/api/integrations/hubspot/callback"],
       "requiredScopes": [
         "oauth",
         "crm.objects.contacts.read", "crm.objects.contacts.write",
         "crm.objects.companies.read", "crm.objects.companies.write",
         "crm.objects.deals.read", "crm.objects.deals.write"
       ],
       "optionalScopes": [],
       "conditionallyRequiredScopes": []
     }
   }
   ```
   The redirect URL must equal `${NEXT_PUBLIC_APP_URL}/api/integrations/hubspot/callback` exactly. ScopeGov sends ALL of these scopes in the
   authorize URL's `scope` parameter, so **they must all be in `requiredScopes`** — a scope sent but not declared makes the install fail, and
   a required scope that is not sent makes HubSpot refuse the install for everyone. Add nothing else (no `crm.schemas.*`).
   Also fill `supportEmail`, `documentationUrl` and `supportUrl` if the template has them (needed later for a listing).
5. `hs project upload`, then `hs project open` → click the app → **Auth** tab: copy the **Client ID** and **Client secret**.
6. Set `HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET` in Vercel (plus `INTEGRATIONS_ENCRYPTION_KEY`, `NEXT_PUBLIC_APP_URL` if not set). Redeploy. Run migration **171**.
7. Test on the developer test account: install the app there, then connect from ScopeGov → "Sync existing projects" → open the deals link.

### The two limits that matter for a product with many customers
- An **unlisted** app with `marketplace` distribution is **capped at 25 installs** (HubSpot enforces this) until a Marketplace listing is approved.
  Customer #26 simply cannot connect. If you expect more than 25 customers to connect HubSpot, apply for a **Marketplace listing** early:
  HubSpot's review takes roughly 10 business days for a first response and up to ~60 days overall. Until it is approved, customers see an extra
  "unverified app" confirmation at install. (`private` distribution is capped much lower — 10 accounts — and is for one-off installs only.)
- Installing an unlisted app requires a **Super Admin** (or a user with App Marketplace access) in the customer's HubSpot account.
- Re-check HubSpot's changelog before launch: the developer platform has changed several times in 2026.

## API versions
ScopeGov uses HubSpot's **OAuth 2026-03** endpoints (`/oauth/2026-03/token`, `/token/introspect`, `/token/revoke`); the older **v1** OAuth
endpoints are deprecated by HubSpot on **2027-02-16** and are not used anywhere (a test enforces that). CRM calls use the `/crm/v3` and `/crm/v4`
endpoints; HubSpot is moving APIs to date-based versions, so skim its changelog now and then.

## Behaviour worth knowing
- Connect checks that every permission was granted and that deal pipelines can be read, so a setup problem shows at connect time.
- Revoked access (the app uninstalled in HubSpot): the next sync flags the connection and switches the rule off; Settings offers **Reconnect**.
  Reconnecting to the SAME portal switches it back on; a DIFFERENT portal forgets the old portal's records and re-picks the pipeline.
- A pipeline without both "Closed won" and "Closed lost" stages is refused when chosen; if the chosen pipeline is later deleted or
  edited the rule switches itself off and says why.
- A project that cannot be synced (deleted, nothing to link) is reported for THAT event only and never counts toward the rule's
  10-failures auto-disable.
- Timeline notes' idempotency records are pruned after 30 days; company/contact/deal records are kept.

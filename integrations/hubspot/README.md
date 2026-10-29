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

## One-time setup (needs your HubSpot developer account — the repo cannot do this)
1. https://developers.hubspot.com → create (or pick) a **developer account** → **Apps → Create app** (a *public app* using OAuth).
2. **Auth tab:** Redirect URL, exactly `${NEXT_PUBLIC_APP_URL}/api/integrations/hubspot/callback`
   (e.g. `https://scopegov.app/api/integrations/hubspot/callback`). **Scopes** — tick exactly these six and nothing else:
   `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.companies.read`, `crm.objects.companies.write`,
   `crm.objects.deals.read`, `crm.objects.deals.write`.
3. Copy the **Client ID** and **Client secret** into Vercel as `HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET`
   (plus `INTEGRATIONS_ENCRYPTION_KEY`, `NEXT_PUBLIC_APP_URL` if not set). Redeploy. Run migration **171**.
4. Test with a free HubSpot **test account** (developer account → Test accounts) before any customer.
5. Customers can install the app by its install URL as soon as it has an app listing's install flow; **listing it in the HubSpot App
   Marketplace is separate** and is HubSpot's review (it is not required for customers to connect via ScopeGov's button).

## Behaviour worth knowing
- Connect checks that every permission was granted and that deal pipelines can be read, so a setup problem shows at connect time.
- Revoked access (the app uninstalled in HubSpot): the next sync flags the connection and switches the rule off; Settings offers **Reconnect**.
  Reconnecting to the SAME portal switches it back on; a DIFFERENT portal forgets the old portal's records and re-picks the pipeline.
- A pipeline without both "Closed won" and "Closed lost" stages is refused when chosen; if the chosen pipeline is later deleted or
  edited the rule switches itself off and says why.
- A project that cannot be synced (deleted, nothing to link) is reported for THAT event only and never counts toward the rule's
  10-failures auto-disable.
- Timeline notes' idempotency records are pruned after 30 days; company/contact/deal records are kept.

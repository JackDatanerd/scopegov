# ScopeGov → Google Drive archive

Every executed contract (signed SOW, accepted change order) is copied, as its original frozen PDF, into the agency's own Drive:

    ScopeGov Archive / <Client> / <Project> / SOW-Website-Redesign-v1-signed.pdf
                                              CO-0003-Second-landing-page-accepted.pdf

Pro plan and above. "Archive past documents" backfills earlier ones (latest 200 of each type per click, once per 10 minutes).
Code: `lib/integrations/google*.ts`, `lib/integrations/drive-*.ts`, `app/api/integrations/google/callback`, `app/api/workspace/integrations/google-drive/*`.

## One-time setup (needs your Google account — the repo cannot do this)
1. https://console.cloud.google.com → create (or pick) a project.
2. **APIs & Services → Library → Google Drive API → Enable.** *(Forgetting this is the commonest mistake. ScopeGov creates the
   archive folder the moment a customer connects, so the mistake shows immediately as "Drive could not be used".)*
3. **APIs & Services → OAuth consent screen** → User type **External** → fill app name, support email, your domain, privacy-policy
   and terms links. **Scopes:** add `.../auth/drive.file`, `openid`, `email` — and nothing else.
4. **Credentials → Create credentials → OAuth client ID → Web application.**
   Authorised redirect URI, exactly: `${NEXT_PUBLIC_APP_URL}/api/integrations/google/callback` (e.g. `https://scopegov.app/api/integrations/google/callback`).
5. Copy the client ID and secret into Vercel: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (plus `INTEGRATIONS_ENCRYPTION_KEY`,
   `NEXT_PUBLIC_APP_URL` if not set). Redeploy. Run migration **170**.
6. **Publish the app** (consent screen → *Publish app* → "In production"). **Do not leave it in "Testing":** for External apps in
   Testing, Google expires refresh tokens after 7 days, so archiving would silently stop a week after each customer connects
   (ScopeGov would then show "needs reconnecting"), and only 100 named test users are allowed.

## Verification — what to expect (confirm in your console; Google changes these rules)
`drive.file` is, as I understand Google's current scope classification, a **non-sensitive** scope: the app can only see files it
created. Apps that request only non-sensitive scopes can generally be published without Google's security review; Google may still
ask you to verify your brand / domain and links. The **restricted** scopes (`drive`, `drive.readonly`) — which this does NOT use —
are the ones that trigger the expensive annual security assessment. Check "Verification status" on the consent screen after
publishing, and read Google's current OAuth verification FAQ before launch.

## What it asks for, and why
`drive.file` create/modify only the files and folders ScopeGov itself created · `openid email` shows which Google account is connected.
It cannot see or touch any other file in the customer's Drive.

## Behaviour worth knowing
- **Frozen PDFs only.** The stored executed PDF is copied byte for byte. A contract with no stored PDF (signed before PDFs were
  frozen) is skipped with the reason shown; it is never re-rendered, because a fresh render could differ from what was signed.
- **Idempotent.** A record of each archived document means retries, duplicate events and repeated backfills never create a second copy.
- **Self-healing.** If the folder is deleted or trashed in Drive, the next document recreates the folders.
- **Drive full / access revoked** → the rule switches itself off and says why; revoked access also flags the connection (Reconnect).
- **Disconnect** revokes ScopeGov's access and forgets the connection. The PDFs already in Drive are the customer's and stay.
- Invoices are not archived: they are rendered on demand, not stored as a fixed executed document.
- Not built: attaching Drive files to SOWs / change orders (import). That needs Google's Picker in the browser and a decision about
  copy-vs-link for evidence; the archive direction was built first because it needs neither.

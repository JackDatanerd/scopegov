ScopeGov — Security Audit Round 3 — Fix Package
=================================================

Scope: fresh clone, full adversarial pass, fixes applied after the pass
was complete (not fixed-as-found). Six code changes + one dependency
cleanup. No DB migration needed this round — nothing here required a
schema or RLS change.

FILES CHANGED
-------------
app/api/co/[id]/close/route.ts
app/api/co/[id]/withdraw/route.ts
app/api/portal/co/[token]/_actions.ts
app/api/portal/co/[token]/accept/route.ts
app/api/portal/sow/[token]/sign/route.ts
app/api/reports/audit-export/route.ts
app/api/scope-governance/[entityType]/[entityId]/attachments/route.ts
package.json
package-lock.json

FINDINGS FIXED
--------------

1. [HIGH] Broken access control on CO close/withdraw
   app/api/co/[id]/close/route.ts
   app/api/co/[id]/withdraw/route.ts

   Every other CO-mutating route (send, remind, escalate, accept-counter,
   create, PATCH) gates on SEND_CHANGE_ORDERS or CREATE_CHANGE_ORDERS.
   These two only checked that a session existed — any authenticated
   workspace member, regardless of role, could close or withdraw any
   change order in the workspace: kills the client's portal link,
   reverts a linked flag to open, and (on withdraw) cancels an in-flight
   approval chain. Confirmed by comparison — the sibling SOW route
   (sow/[id]/withdraw) already checks SEND_SOW, so this was an omission,
   not a design choice. Added the same SEND_CHANGE_ORDERS check used
   everywhere else in the CO route family.

2. [MEDIUM] PostgREST filter injection in audit log export
   app/api/reports/audit-export/route.ts

   The free-text `q` search param was interpolated raw into
   `.or(\`event_type.ilike.%${q}%,entity_name.ilike.%${q}%\`)`.
   PostgREST's or() syntax is comma/paren-delimited, so untrusted
   commas/parens/dots in `q` could break the intended filter shape.
   workspace_id is a separate, independently-ANDed query param, so this
   was never a cross-tenant read — but it's the wrong way to build a
   filter string, and the kind of pattern that becomes a real bug the
   next time it's copied into a route without that compensating filter.
   Now escapes PostgREST's special characters before building the
   filter, the same way you'd escape a LIKE pattern.

3. [MEDIUM] Client-controlled MIME type on flag-evidence uploads
   app/api/scope-governance/[entityType]/[entityId]/attachments/route.ts

   file.type on a browser File/FormData object is whatever the client
   claims — trivially spoofed (rename evil.html to evil.png, or hand-
   build the multipart part). It was used as both the allowlist check
   AND the stored object's Content-Type. Exploitability was already
   limited (private bucket, signed-URL download only, nothing ever
   inlines these), but added a magic-byte check for every binary type
   in the allowlist (PDF, PNG, JPEG, WEBP, DOCX-as-zip) so a mislabeled
   file is rejected before it's ever written to storage. text/plain and
   message/rfc822 have no reliable signature, so those still rely on
   the declared type — same as before, just narrower blast radius now.

4. [LOW] Missing upper bound on signature-pad payload
   app/api/portal/co/[token]/accept/route.ts
   app/api/portal/sow/[token]/sign/route.ts

   client_signature_data had a "starts with data:image/" check and
   nothing else — no size cap. A real signature drawing is a few KB;
   nothing stopped an arbitrarily large base64 payload being submitted
   and stored (storage bloat, and this value gets re-embedded into
   every future PDF render of the document). Capped at 500 KB, well
   above anything a real signature pad produces.

5. [LOW] CO counter-offer amount validation gap
   app/api/portal/co/[token]/_actions.ts (POST_COUNTER)

   `!counterAmount || parseFloat(counterAmount) <= 0` doesn't catch a
   non-numeric string: `!counterAmount` is false for any non-empty
   string, and `NaN <= 0` is always false in JS, so e.g. counterAmount:
   "abc" sailed through. JSON.stringify(NaN) serializes to null, so the
   row silently got a null counter_amount instead of the request being
   rejected — not exploitable, just wrong. Now parses once and checks
   Number.isFinite() before accepting.

6. [Hygiene] Removed sharp and stripe from package.json
   package.json / package-lock.json

   Neither is imported anywhere in the codebase (checked: zero `from
   'sharp'` / `from 'stripe'` in app/lib — the "stripe" you'll still see
   in components/types is just the literal string label for a payment-
   method enum, unrelated to the npm package). sharp specifically had
   open libvips CVEs (npm audit, high severity) that were shipping in
   node_modules for a dependency that never actually ran. Dropping both
   removes them from the install and from npm audit's output entirely
   — confirmed via `npm audit` before/after.
   NOTE: openai IS actually used (lib/ai/guardian.ts, embeddings for
   Guardian classification) — flagged as a maybe-dead-dep in the audit
   summary, that was wrong, left it in.

NOT FIXED THIS ROUND — NEEDS YOUR DECISION, NOT A TARBALL
-----------------------------------------------------------

A. Next.js 14.2.29 has multiple unpatched high-severity advisories
   (SSRF via Server Actions/rewrites, HTTP request smuggling, cache
   poisoning, XSS via CSP nonces, several DoS vectors). Tested bumping
   to 14.2.35 (latest 14.2.x) — same advisories still apply. They're
   only fixed on Next 15/16. That's a major-version migration, not a
   patch: real risk of breaking changes across app router, middleware,
   and the cookie/session handling this app leans on heavily. Worth
   scheduling as its own project with a full regression pass, not
   bundling into a security-fix tarball.

B. Logo upload bypasses the API layer entirely.
   components/settings/SettingsClient.tsx calls
   `supabase.storage.from('logos').upload()` directly from the browser
   — the only client-to-storage write path in the whole app. Every
   other write goes through an API route with its own permission +
   workspace check. This one's authorization lives entirely in
   Supabase Storage bucket policies, which aren't in this repo and I
   can't verify from code. Needs a manual check in the Supabase
   dashboard: confirm the `logos` bucket's storage policy scopes
   INSERT/UPDATE to a path prefix matching the caller's own
   workspace_id (via a policy that joins auth.uid() through
   workspace_members), not just "role = authenticated". Given
   migration 010 already caught this exact class of bug once (RLS
   assumed-but-not-actually-enabled on 12 tables), this is worth
   checking directly rather than assuming it's fine.

C. Pre-existing lint failure in components/settings/SettingsClient.tsx
   (two unescaped `"` — react/no-unescaped-entities) currently fails
   `next build` if your CI runs lint-as-part-of-build. Not something
   introduced by this round, not a security issue, just flagging since
   it surfaced while verifying these fixes built cleanly. Two-line fix
   whenever you want it (swap the raw quotes for &quot; on lines
   392:132 and 392:145).

VERIFICATION DONE
------------------
- Full adversarial pass across all ~90 API routes, all 41 tables' RLS,
  middleware/AAL2 enforcement, MFA flows, portal token routes (CO/SOW/
  invoice), both webhooks (Paystack + Postmark), the approval engine,
  cron auth, file uploads, notifications, every rich-text/plain-text
  sanitization write path, client components, and `npm audit`.
- `npx tsc --noEmit` clean on every changed file.
- `next build` compiles successfully (webpack/TS pass) with these
  changes in place — the only build failure is the pre-existing,
  unrelated lint issue in item C above.
- `npm audit` re-run after the dependency cleanup: sharp's libvips
  CVEs are gone. Only the Next.js/PostCSS advisories from item A
  remain, as expected.

GIT COMMANDS
------------
cd "C:\Users\jackk\Desktop\MyWebApps\scopegov\scopegov"
tar -xzf ~/Downloads/scopegov-audit-round3-fixes-001.tar.gz --strip-components=1 -C .
git add -A
git commit -m "security: CO close/withdraw permission gap, PostgREST filter injection, upload MIME spoofing, signature size cap, counter-amount validation, drop unused sharp/stripe deps"
git push

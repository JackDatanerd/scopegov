-- ============================================================
-- ScopeGov — Migration 029: revoked_tokens.document_id
--
-- FIX (portal audit, section 18 — flagship finding): both the SOW sign
-- route and CO's finalize-co.ts rotate the document's `token` column to a
-- fresh, long-lived value on completion (deliberately — to decouple the
-- short signing-window expiry from long-term post-signature access). But
-- the very first "please review/sign" email a client ever received links
-- to the OLD token, which is never patched (can't be — it's already
-- sent). Once that token stops matching sow_documents.token /
-- change_orders.token, the row is simply unfindable by it, and the client
-- lands on "this link is no longer active" instead of their own finalized
-- document.
--
-- app/api/portal/co/[token]/route.ts already has an elaborate "critical
-- finding" fix that explicitly tries to handle exactly this case — but it
-- rests on the claim that "'declined' and 'superseded' never touch
-- change_orders.token," which is false: finalize-co.ts's own token-reissue
-- step does touch it. The fix documents the right problem and doesn't
-- actually solve it.
--
-- revoked_tokens has no way to say which document an old token belonged
-- to (token, token_type, reason, revoked_at, revoked_by only) — so once
-- the token column is overwritten, an old-token lookup has nothing to
-- fall back to. Adding a nullable document_id here lets the GET/PDF
-- routes, on a direct token-match miss, check whether the token was
-- specifically superseded (not declined/withdrawn — those never rotate
-- the column, so they're already resolvable directly) and if so re-fetch
-- the live document by this id instead.
-- ============================================================

ALTER TABLE public.revoked_tokens
  ADD COLUMN IF NOT EXISTS document_id uuid;

CREATE INDEX IF NOT EXISTS revoked_tokens_document_id
  ON public.revoked_tokens(document_id) WHERE document_id IS NOT NULL;

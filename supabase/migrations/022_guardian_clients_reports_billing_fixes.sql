-- Audit round 6 (Guardian / Clients / Reports / Billing deep-dive)
-- NOTE ON NUMBERING: this file went through three names before landing
-- here. Two separate pre-delivery fresh-clone checks (this codebase had
-- other audit sessions actively landing work in parallel throughout this
-- one) each found the number this migration was using had already been
-- taken upstream in the meantime:
--   019_audit_round6_fixes.sql        -> collided with 019_section_audit_fixes.sql
--   020_guardian_..._fixes.sql        -> collided with 020_purge_functions_and_invite_expiry.sql
--   021 was also taken (021_client_search_vector_drop_email.sql)
-- Landed as 022. No content below was changed by the renumbering — only
-- the filename.

-- ── Guardian: "borderline" classification outcome was a dead end ──────────
-- lib/ai/guardian.ts has produced a 'borderline' outcome since Phase 2, and
-- the model is explicitly instructed to prefer it over 'out_of_scope' to
-- reduce false positives — but nothing ever created a reviewable record for
-- it. guardian_flags.status also had no value for "AI thinks this might be
-- scope creep, a human should look" distinct from a fully-raised flag.
-- Add 'borderline_review' as a status, and 'info' as a severity so a
-- borderline flag doesn't have to falsely claim high/medium/low confidence.
ALTER TABLE public.guardian_flags DROP CONSTRAINT IF EXISTS guardian_flags_status_check;
ALTER TABLE public.guardian_flags ADD CONSTRAINT guardian_flags_status_check
  CHECK (status IN ('open','resolved','closed','converted_to_co','borderline_review'));

ALTER TABLE public.guardian_flags DROP CONSTRAINT IF EXISTS guardian_flags_severity_check;
ALTER TABLE public.guardian_flags ADD CONSTRAINT guardian_flags_severity_check
  CHECK (severity IN ('high','medium','low','info'));

-- 'not_out_of_scope' resolution — a reviewer dismissing a borderline item
-- as a false positive isn't a change_order, an exception, or a plain
-- 'closed' flag; it's its own resolution so reporting can tell them apart.
ALTER TABLE public.guardian_flags DROP CONSTRAINT IF EXISTS guardian_flags_resolution_check;
ALTER TABLE public.guardian_flags ADD CONSTRAINT guardian_flags_resolution_check
  CHECK (resolution IN ('change_order','exception','closed','not_out_of_scope'));

-- ── Guardian: scope-adjustment race condition ──────────────────────────────
-- api/guardian/scope-adjustment does a read-modify-write on
-- project_scope_snapshot.deliverables with no locking and no transaction
-- (its own comment admits this: "best-effort sequential here"). Two
-- concurrent adjustments can silently clobber each other. Add a version
-- column so the write can be made conditional (optimistic concurrency) —
-- supabase-js can't take a real row lock, but it can refuse to write if the
-- version it read is no longer current.
ALTER TABLE public.project_scope_snapshot ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

-- ── Billing: webhook redelivery has no idempotency guard ───────────────────
-- Paystack (like any payment provider) redelivers webhooks on timeout or a
-- non-2xx response. Nothing in the handler recognizes "I've already
-- processed this exact event," so a redelivery can re-send customer emails
-- (invoice.payment_failed) and double-log audit entries. Track processed
-- events by a stable idempotency key derived from the event.
CREATE TABLE IF NOT EXISTS public.processed_webhook_events (
  idempotency_key text PRIMARY KEY,
  processed_at    timestamptz NOT NULL DEFAULT now()
);

-- ── Guardian: inbound email path had zero AI rate limiting ─────────────────
-- api/guardian/check got rate limiting in a prior round (ai_usage_log,
-- keyed by user_id) because it calls a paid embedding + classification
-- model per submission. api/guardian/inbound runs the identical pipeline
-- from an unauthenticated webhook (Postmark forwarding project email) and
-- was never wired to it — no user_id exists in that context to key on.
-- Widen ai_usage_log to also support project-keyed usage/limiting for
-- exactly this case.
ALTER TABLE public.ai_usage_log ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.ai_usage_log ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_project_window
  ON public.ai_usage_log (project_id, route_key, created_at DESC) WHERE project_id IS NOT NULL;

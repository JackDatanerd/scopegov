-- ============================================================
-- ScopeGov — Migration 063
-- Cron jobs (section 17) + public portal routes (section 18), audit round 2.
-- Idempotent. RUN THIS BEFORE deploying the matching code: cron/payment-overdue selects
-- invoices.dispute_resolved_at, the settings page selects the new workspaces columns, and the CO
-- routes read change_orders.renewal_term_months.
-- ============================================================

-- ── 1. revoked_tokens: invoice links ───────────────────────────────────────────────────────
-- invoices/[id]/void inserted { token_type: 'invoice', reason: <free text or 'voided'> }. The table's
-- CHECK constraints only allowed token_type IN ('sow','co') and a fixed reason list, so that insert
-- ALWAYS failed — silently, because the result was never read. Invoice links are now also revoked_tokens
-- citizens: 'superseded' rows (written when an expired invoice token is renewed) let the client's
-- ORIGINAL emailed link keep resolving to the same invoice, the way SOW/CO links already do.
ALTER TABLE public.revoked_tokens DROP CONSTRAINT IF EXISTS revoked_tokens_token_type_check;
ALTER TABLE public.revoked_tokens ADD CONSTRAINT revoked_tokens_token_type_check
  CHECK (token_type IN ('sow','co','invoice'));

-- ── 2. One retainer milestone per project per calendar month ───────────────────────────────
-- cron/retainer-milestones de-duplicated with SELECT-then-INSERT and nothing in the database backed it
-- up, so two overlapping runs (or a run racing the SOW signing that creates month 1) could bill a month
-- twice. Keyed on the FIRST OF THE MONTH of due_date so it doesn't matter which day the row was stamped.
-- Exact duplicates that are still 'pending' and were never invoiced are removed (oldest kept); if any
-- duplicate remains after that (already invoiced/paid — a financial record), the index is NOT created
-- and a NOTICE says so, exactly like migration 061's guardian_email index.
DELETE FROM public.payment_milestones m
 USING (
   SELECT id,
          ROW_NUMBER() OVER (
            PARTITION BY project_id, (due_date - ((EXTRACT(DAY FROM due_date))::int - 1))
            ORDER BY created_at ASC, id ASC
          ) AS rn
     FROM public.payment_milestones
    WHERE type = 'retainer_monthly' AND due_date IS NOT NULL
 ) d
 WHERE m.id = d.id AND d.rn > 1
   AND m.status = 'pending'
   AND NOT EXISTS (SELECT 1 FROM public.invoices i WHERE i.milestone_id = m.id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.payment_milestones
     WHERE type = 'retainer_monthly' AND due_date IS NOT NULL
     GROUP BY project_id, (due_date - ((EXTRACT(DAY FROM due_date))::int - 1))
    HAVING count(*) > 1
  ) THEN
    RAISE NOTICE 'payment_milestones_retainer_month_unique NOT created: duplicate retainer months remain (already invoiced/paid). Resolve them by hand and re-run this statement.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS payment_milestones_retainer_month_unique
      ON public.payment_milestones (project_id, (due_date - ((EXTRACT(DAY FROM due_date))::int - 1)))
      WHERE type = 'retainer_monthly' AND due_date IS NOT NULL;
  END IF;
END $$;

-- ── 3. Invoice dispute lifecycle ────────────────────────────────────────────────────────────
-- A client could flag an invoice as disputed (migration 046) but the agency had no way to answer or
-- close it, so "disputed" stuck to an invoice forever, even after it was paid. The dispute is resolved
-- with an optional note the client can see; a client may dispute again afterwards (the dispute route
-- clears these three columns).
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS dispute_resolved_at    timestamptz;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS dispute_resolution_note text;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS dispute_resolved_by    uuid REFERENCES public.users(id);

-- ── 4. Retainer renewal term ────────────────────────────────────────────────────────────────
-- A retainer-renewal change order replaced the monthly rate (projects.contract_value) but said nothing
-- about how much longer the retainer runs, so a renewed retainer still stopped generating milestones at
-- its ORIGINAL end date. The renewal now states its term; accepting it adds that many months to
-- projects.retainer_duration_months.
ALTER TABLE public.change_orders ADD COLUMN IF NOT EXISTS renewal_term_months integer
  CHECK (renewal_term_months IS NULL OR (renewal_term_months BETWEEN 1 AND 120));

-- ── 5. Automatic client reminders (opt-in) ──────────────────────────────────────────────────
-- Every stall cron only told the AGENCY. Chasing the client was a manual button per document. With
-- this on, cron/client-reminders nudges the client about unsigned SOWs, unanswered change orders and
-- overdue invoices: first after `client_reminder_after_days`, then every that-many days, at most
-- `client_reminder_max` automatic reminders per document. Off by default.
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS auto_client_reminders boolean NOT NULL DEFAULT false;
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS client_reminder_after_days integer NOT NULL DEFAULT 3
  CHECK (client_reminder_after_days BETWEEN 1 AND 30);
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS client_reminder_max integer NOT NULL DEFAULT 3
  CHECK (client_reminder_max BETWEEN 1 AND 10);

-- ── 6. OPTIONAL — purge OAuth identity data of anonymized accounts ─────────────────────────
-- cron/invite-cleanup now anonymizes the auth.users row (email, password, metadata, MFA factors) and
-- bans it. The GoTrue admin API cannot delete auth.identities rows, whose identity_data still holds the
-- provider's email/name for accounts that signed in with Google. Run when you want that gone too:
--
--   DELETE FROM auth.identities
--    WHERE user_id IN (SELECT id FROM public.users WHERE email LIKE 'deleted-%@deleted.scopegov.app');

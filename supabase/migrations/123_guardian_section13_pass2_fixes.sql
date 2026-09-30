-- ============================================================
-- ScopeGov — Migration 123: Guardian section 13, independent pass 2
--
-- FIX (G2): guardian_flags had no uniqueness on check_id, so two concurrent classifications of the same
-- check (a live request + the guardian-health sweep, or a sweep + a manual retry that both got past their
-- claims) each inserted a flag and each emailed the team. classifyAndRecord now treats a 23505 on this
-- index as "already flagged" (links and returns the existing flag, no second email).
--
-- Partial: check_id is set to NULL when a project is purged (020), and those rows must not collide.
-- Created only when no check already has two flags (same skip-with-NOTICE convention as 077) — if the NOTICE
-- appears, merge the duplicate flags for the listed checks and re-run the CREATE INDEX below.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.guardian_flags WHERE check_id IS NOT NULL GROUP BY check_id HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS guardian_flags_check_id_unique
      ON public.guardian_flags (check_id) WHERE check_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'guardian_flags has checks with more than one flag — guardian_flags_check_id_unique NOT created.';
  END IF;
END $$;

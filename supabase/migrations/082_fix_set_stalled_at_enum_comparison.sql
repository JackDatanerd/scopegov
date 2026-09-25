-- ============================================================
-- 082 — fix set_stalled_at() breaking every projects.status write
--
-- FIX (found while re-running tests/pg-replay.test.ts as part of an
-- unrelated Auth+MFA / RLS+permissions audit round — traced and fixed per
-- standing instruction to close out anything found outside the two
-- audited sections, since another session working a different section
-- could easily miss it).
--
-- migration 078 added set_stalled_at() as a single trigger function shared
-- by public.projects (status column typed as the project_status ENUM) and
-- public.change_orders (status column typed as plain text). The function
-- compares `NEW.status = TG_ARGV[0]` — TG_ARGV[] entries are always text,
-- and Postgres has no `project_status = text` operator, so the comparison
-- raises `operator does not exist: project_status = text` and the
-- statement fails outright. Because the trigger is `BEFORE INSERT OR
-- UPDATE OF status`, this isn't a narrow edge case: it fires on every
-- single INSERT into public.projects (any project.status is set at
-- creation, even to its default) and every UPDATE that touches status —
-- i.e. POST /api/projects (create project) and every status transition
-- anywhere in the app were completely broken the moment 078 was deployed.
-- (public.change_orders was unaffected — its status column is `text`, so
-- `NEW.status = TG_ARGV[0]` type-checks fine there; only the projects
-- trigger ever raised.)
--
-- Fix: cast NEW.status to text for the comparison. This works for both
-- callers (the enum coerces to its label text; the already-text column is
-- a no-op cast), so one definition keeps serving both triggers as
-- originally intended.
CREATE OR REPLACE FUNCTION public.set_stalled_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status::text = TG_ARGV[0] THEN
    IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
      NEW.stalled_at := now();
    END IF;
  ELSE
    NEW.stalled_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

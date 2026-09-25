-- ============================================================
-- 078 — stalled_at on projects and change_orders; project_unread_message_counts()
--
-- The Portfolio's "Stalled documents" list showed a "since" date, but nothing recorded WHEN a project or
-- change order stalled: the SOW rows used projects.updated_at (any edit — rename, contract-value tweak —
-- resets it) and the CO rows used change_orders.updated_at (also moved by unrelated writes). The list is
-- sorted oldest-first and exported to CSV/PDF, so the age was quietly wrong. The Dashboard also needs it
-- to stop flagging a deliberate, recent manual pause as "needs attention".
--
-- A trigger (not application code) because projects.status = 'Stalled' is written from several places:
-- PATCH /api/projects/[id] (manual pause), the sow-stall cron, and SOW/CO routes that resume it. One
-- trigger covers every writer, present and future.
--
-- Semantics: stalled_at is set when the row ENTERS the stalled status and cleared when it leaves it.
--
-- Deploy order: apply this BEFORE deploying the code that selects stalled_at (Dashboard, Projects list,
-- Portfolio) — until then those pages error on the missing column. Idempotent.
-- ============================================================

ALTER TABLE public.projects       ADD COLUMN IF NOT EXISTS stalled_at timestamptz;
ALTER TABLE public.change_orders  ADD COLUMN IF NOT EXISTS stalled_at timestamptz;

-- Backfill: the best available approximation for rows that are stalled right now.
UPDATE public.projects      SET stalled_at = updated_at WHERE status = 'Stalled' AND stalled_at IS NULL;
UPDATE public.change_orders SET stalled_at = updated_at WHERE status = 'stalled' AND stalled_at IS NULL;

-- TG_ARGV[0] is the status value that means "stalled" for the table ('Stalled' / 'stalled').
CREATE OR REPLACE FUNCTION public.set_stalled_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = TG_ARGV[0] THEN
    IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
      NEW.stalled_at := now();
    END IF;
  ELSE
    NEW.stalled_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_projects_stalled_at ON public.projects;
CREATE TRIGGER trg_projects_stalled_at
  BEFORE INSERT OR UPDATE OF status ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.set_stalled_at('Stalled');

DROP TRIGGER IF EXISTS trg_change_orders_stalled_at ON public.change_orders;
CREATE TRIGGER trg_change_orders_stalled_at
  BEFORE INSERT OR UPDATE OF status ON public.change_orders
  FOR EACH ROW EXECUTE FUNCTION public.set_stalled_at('stalled');

-- ── Unread Discussion messages, per project, for one user ──────────────────────────────────────────
-- The Discussion tab's unread badge was only computed on the project page itself, so a new message was
-- invisible everywhere else. The Projects list now shows a per-project unread count from this function.
-- Same definition as GET /api/projects/[id]/messages/unread-count: messages by OTHER people, not deleted,
-- newer than the user's read high-water mark (or all of them if they have never opened the discussion).
-- The caller passes only project ids the user is allowed to see. The pages that call it degrade to "no
-- badges" if this function is missing, so it does not gate a deploy.
CREATE OR REPLACE FUNCTION public.project_unread_message_counts(p_user_id uuid, p_project_ids uuid[])
RETURNS TABLE (project_id uuid, unread bigint)
LANGUAGE sql STABLE AS $$
  SELECT m.project_id, count(*)::bigint
    FROM public.project_messages m
    LEFT JOIN public.project_message_reads r
           ON r.project_id = m.project_id AND r.user_id = p_user_id
   WHERE m.project_id = ANY (p_project_ids)
     AND m.deleted_at IS NULL
     AND m.author_id <> p_user_id
     AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
   GROUP BY m.project_id
$$;

REVOKE ALL ON FUNCTION public.project_unread_message_counts(uuid, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_unread_message_counts(uuid, uuid[])
  TO service_role;

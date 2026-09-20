-- ============================================================
-- ScopeGov — Migration 061
-- SOW lifecycle (section 9) + CO logic (section 10) fix round.
--
-- 1. Executed-document integrity
--    An executed SOW / change order used to be re-rendered from live rows on every
--    download and no record existed of what was actually agreed. We now store the
--    PDF rendered at the moment of signing plus a SHA-256 of the agreed content.
--      sow_documents.pdf_path      (already existed, never written)  -> now written
--      sow_documents.content_hash  NEW
--      change_orders.pdf_path      NEW
--      change_orders.content_hash  NEW
--    The PDFs live in the private `pdfs` storage bucket (service-role access only;
--    no storage policies are created, so anon/authenticated cannot read them).
--
-- 2. amendments.previous_contract_value
--    A retainer-renewal CO overwrites projects.contract_value with the new monthly
--    rate. The CO's own PDF ("before" value) can no longer be recomputed after that,
--    so the rate that was replaced is recorded on the amendment.
--
-- 3. One draft SOW per project
--    generate / reopen / request-changes each guard against an existing draft in
--    code, but two concurrent requests could still create two. A partial unique
--    index makes it impossible. Existing duplicate drafts (keep the highest
--    version) are marked 'withdrawn' first — they were never sent to anyone.
--
-- 4. Unique guardian_email
--    guardian/inbound resolves a project with `.single()` on the address; a
--    duplicate makes both projects silently unroutable. Created only if no
--    duplicates exist today (otherwise a NOTICE is raised and nothing is changed).
-- ============================================================

ALTER TABLE public.sow_documents ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE public.change_orders ADD COLUMN IF NOT EXISTS pdf_path     text;
ALTER TABLE public.change_orders ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE public.amendments    ADD COLUMN IF NOT EXISTS previous_contract_value decimal;

-- Private bucket for executed PDFs.
INSERT INTO storage.buckets (id, name, public)
VALUES ('pdfs', 'pdfs', false)
ON CONFLICT (id) DO NOTHING;

-- One draft SOW per project.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY version DESC, created_at DESC) AS rn
  FROM public.sow_documents
  WHERE status = 'draft'
)
UPDATE public.sow_documents s
   SET status = 'withdrawn', updated_at = now()
  FROM ranked r
 WHERE s.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS sow_documents_one_draft_per_project
  ON public.sow_documents (project_id)
  WHERE status = 'draft';

-- Unique guardian_email (case-insensitive), only when safe to add.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.projects
    WHERE guardian_email IS NOT NULL
    GROUP BY lower(guardian_email)
    HAVING count(*) > 1
  ) THEN
    RAISE NOTICE 'projects_guardian_email_unique NOT created: duplicate guardian_email values exist — resolve them and re-run this statement.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS projects_guardian_email_unique
      ON public.projects (lower(guardian_email))
      WHERE guardian_email IS NOT NULL;
  END IF;
END $$;

-- ── 5. Atomic per-section SOW patch ─────────────────────────────────────────
-- PATCH /api/sow/[id] used to read the whole `sections` array, change one element in
-- JavaScript and write the whole array back. Two autosaves in flight for different
-- sections (or two teammates) raced, and the later write silently discarded the
-- earlier one while the UI said "Saved". This merges a JSON patch into ONE section
-- inside a single UPDATE (the row lock serialises concurrent callers), and refuses to
-- touch anything that is no longer an unsent draft — closing the check-then-write gap
-- against a simultaneous send as well.
CREATE OR REPLACE FUNCTION public.sow_apply_section_patch(
  p_sow_id uuid, p_section_id text, p_patch jsonb
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE public.sow_documents d
     SET sections = (
           SELECT jsonb_agg(
                    CASE WHEN e->>'id' = p_section_id THEN e || p_patch ELSE e END
                    ORDER BY ord)
             FROM jsonb_array_elements(d.sections) WITH ORDINALITY AS t(e, ord)
         ),
         updated_at = now()
   WHERE d.id = p_sow_id
     AND d.status = 'draft'
     AND d.sent_at IS NULL
     AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(d.sections) x WHERE x->>'id' = p_section_id
         );
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.sow_apply_section_patch(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sow_apply_section_patch(uuid, text, jsonb) TO service_role;

-- ── 6. Retainer-renewal amendments recorded BEFORE this fix ──────────────────
-- A retainer-renewal CO overwrites projects.contract_value with the new monthly rate AND used to record
-- the same total as the amendment's financial_impact; effective contract value is
-- contract_value + Σ financial_impact, so each renewal counted twice. New renewals now record 0.
-- Existing rows are NOT rewritten automatically (they are financial records — review them first):
--
--   SELECT a.id, a.project_id, a.title, a.financial_impact, c.total
--     FROM public.amendments a
--     JOIN public.change_orders c ON c.id = a.change_order_id
--     JOIN public.projects p      ON p.id = c.project_id
--    WHERE c.is_retainer_renewal AND p.type = 'retainer' AND a.financial_impact <> 0;
--
-- Once you have confirmed those rows are the double-counted renewals, run:
--
--   UPDATE public.amendments a SET financial_impact = 0
--     FROM public.change_orders c, public.projects p
--    WHERE a.change_order_id = c.id AND c.project_id = p.id
--      AND c.is_retainer_renewal AND p.type = 'retainer' AND a.financial_impact <> 0;

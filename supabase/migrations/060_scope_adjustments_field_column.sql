-- ── Guardian: scope adjustments could only ever target `deliverables` ─────
-- api/guardian/scope-adjustment has only ever matched/rewritten
-- project_scope_snapshot.deliverables — there was no way, in the UI or the
-- API, to fix a typo/wording issue in an out_of_scope ("Excluded") entry,
-- even though those are just as prone to a typo as an in-scope deliverable
-- and live in the exact same snapshot row. Widening the route to accept
-- either list needs a way for scope_adjustments (the audit trail of every
-- correction made) to record which one was touched — without this, every
-- future out_of_scope correction would misreport itself as a deliverable
-- change to anyone reading the history.
--
-- Nullable + defaulted rather than backfilled with a guess: every existing
-- row really was a deliverable adjustment (out_of_scope had no path to get
-- one), so the default is exact, not a placeholder.
ALTER TABLE public.scope_adjustments
  ADD COLUMN IF NOT EXISTS field text NOT NULL DEFAULT 'deliverables'
    CHECK (field IN ('deliverables', 'out_of_scope'));

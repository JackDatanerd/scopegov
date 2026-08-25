-- 018_co_scope_timeline_impact.sql
--
-- FIX (doc-quality audit round 3): the CO PDF's "Contract Value Impact"
-- block only ever showed the financial delta (Original / This CO /
-- Revised). A firm-issued change order's Impact Analysis shows Scope,
-- Timeline, and Value as three before-and-after rows — a CO that pushes
-- a milestone date or adds/removes scope had nowhere structured to say
-- so; that only ever lived in the free-text `note` field, indistinguishable
-- from the general "reason for change" prose. These two columns are
-- optional and additive — a CO with neither set renders exactly as
-- before (see renderer.tsx's impactSecNum gate).

ALTER TABLE public.change_orders
  ADD COLUMN IF NOT EXISTS timeline_impact_days integer,
  ADD COLUMN IF NOT EXISTS scope_impact_note    text;

COMMENT ON COLUMN public.change_orders.timeline_impact_days IS
  'Net schedule shift this CO introduces, in days. Positive = pushes the timeline out, negative = pulls it in. NULL = no timeline impact / not specified. Optional, agency-entered.';
COMMENT ON COLUMN public.change_orders.scope_impact_note IS
  'Short agency-entered description of what scope is added/removed by this CO, shown as its own row in the CO PDF''s Impact Analysis alongside Timeline and Value. NULL = not specified.';

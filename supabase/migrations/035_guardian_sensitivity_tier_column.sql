-- ============================================================
-- ScopeGov — Migration 035: add missing workspaces.guardian_sensitivity_tier
--
-- FIX (deep audit, Settings + Team & Invites round, cross-referenced into
-- Guardian): this column is read/written in four places —
--   - app/(app)/settings/page.tsx            (SELECT)
--   - app/api/workspace/settings/route.ts    (PATCH, via fieldMap)
--   - app/api/guardian/check/route.ts        (joined off projects.workspaces)
--   - app/api/guardian/inbound/route.ts      (joined off projects.workspaces)
-- and lib/supabase/types.ts already exports a GuardianSensitivity type and
-- SettingsClient.tsx already ships a full "Sensitivity tier" <select> for
-- it — but the column itself was never created in any migration. Confirmed
-- by exhaustive grep across every .sql file in this repo.
--
-- Effect this had: the Settings page's server-side `.select(...).single()`
-- includes this column, PostgREST errors on the unknown column, the error
-- is never checked, and `wsRes.data` comes back null — the entire Settings
-- page silently rendered blank/default values instead of the workspace's
-- real saved settings. Separately, both Guardian routes join this same
-- column into their main project-fetch query; that query errors the same
-- way, `project` comes back null, and the route returns a blanket "Project
-- not found" — meaning Guardian's core scope-risk classification failed on
-- every submission, in every workspace.
--
-- Values match lib/ai/guardian.ts's `Sensitivity` type exactly
-- ('conservative' | 'medium' | 'aggressive'), and 'medium' matches the
-- fallback every read site already assumes (`|| 'medium'`), so this
-- migration's default reproduces existing code's assumed behavior for
-- every workspace created before this column existed.
-- ============================================================

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS guardian_sensitivity_tier text NOT NULL DEFAULT 'medium';

ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_guardian_sensitivity_tier_check;

ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_guardian_sensitivity_tier_check
  CHECK (guardian_sensitivity_tier IN ('conservative', 'medium', 'aggressive'));

-- Same class of ordinary, non-secret workspace configuration as the
-- sibling proactive_risk_threshold / proactive_risk_alerts_enabled columns,
-- which 032_workspaces_column_privilege_lockdown.sql already grants to
-- `authenticated` — extend that same allow-list rather than leaving this
-- column unreachable outside the service-role client, for consistency
-- with those siblings and in case a future client-side read needs it.
-- (Every current read site already uses the service-role client, so this
-- grant doesn't change existing behavior — it just avoids leaving a
-- foot-gun for whoever adds the next one.)
GRANT SELECT (guardian_sensitivity_tier) ON public.workspaces TO authenticated;

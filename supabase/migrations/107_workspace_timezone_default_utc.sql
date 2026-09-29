-- 107_workspace_timezone_default_utc.sql
-- Every default timezone is UTC. The column default was 'Africa/Nairobi' while the app's
-- onboarding wizard used America/New_York; app code now defaults to UTC
-- (lib/constants/workspace-options.ts DEFAULT_TIMEZONE). Only affects future inserts that
-- omit timezone; existing workspaces keep whatever zone they chose.
ALTER TABLE public.workspaces ALTER COLUMN timezone SET DEFAULT 'UTC';

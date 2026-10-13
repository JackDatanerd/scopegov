-- 160_default_approval_silence.sql
--
-- Optional "if the Client does not respond" rule for new SOWs. NULL = the SOW says nothing about it (the drafting prompt also
-- forbids the model from inventing one). 'deemed_approved' = a deliverable the Client neither approves nor comments on within
-- default_approval_days business days is deemed approved. 'work_waits' = the Provider does not proceed until approval is given.
-- Fixed, app-owned wording (lib/documents/approval-silence.ts), frozen into the SOW's metadata at drafting.
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS default_approval_silence text,
  ADD COLUMN IF NOT EXISTS default_approval_days integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_default_approval_silence_values') THEN
    ALTER TABLE public.workspaces
      ADD CONSTRAINT workspaces_default_approval_silence_values
      CHECK (default_approval_silence IS NULL OR default_approval_silence IN ('deemed_approved', 'work_waits'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_default_approval_days_range') THEN
    ALTER TABLE public.workspaces
      ADD CONSTRAINT workspaces_default_approval_days_range
      CHECK (default_approval_days IS NULL OR (default_approval_days BETWEEN 1 AND 30));
  END IF;
END $$;

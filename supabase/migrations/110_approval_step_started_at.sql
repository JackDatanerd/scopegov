-- ============================================================
-- 110: approval_requests.step_started_at — a "how long has the CURRENT step been
--      waiting" clock that the stall cron's reminder bump cannot reset
--
-- RUN THIS BEFORE DEPLOYING THE MATCHING CODE (dashboard/projects attention reads,
-- lib/approvals/engine.ts reassignApprovalStep). The dashboard and projects list
-- SELECT this column; deployed ahead of the migration their approval query errors
-- and the "awaiting approval" attention flags disappear until it is applied.
--
-- FIX (section-11 audit, B5): the dashboard/projects "stuck approval" attention
-- flag measured age from approval_requests.updated_at. That column is ALSO the
-- approval-stall cron's quiet-window marker — the cron bumps it after every
-- reminder so it doesn't nag daily. Net effect: a request stuck for 2 days was
-- flagged until the next cron run, then vanished from "needs attention" for two
-- more days after each nudge, flickering on and off while nobody had decided
-- anything. This column is set when a request is created, when decide_approval_step
-- advances it to the next step, and when a step is reassigned (engine.ts) — and is
-- never touched by reminders.
-- ============================================================

ALTER TABLE public.approval_requests
  ADD COLUMN IF NOT EXISTS step_started_at timestamptz;

-- Backfill: the moment the current step became active is the last approved step's
-- decided_at, or the request's creation time if nothing has been approved yet.
UPDATE public.approval_requests r
SET step_started_at = COALESCE(
  (SELECT max(s.decided_at) FROM public.approval_steps s
    WHERE s.request_id = r.id AND s.status = 'approved'),
  r.created_at
)
WHERE r.step_started_at IS NULL;

ALTER TABLE public.approval_requests ALTER COLUMN step_started_at SET DEFAULT now();
ALTER TABLE public.approval_requests ALTER COLUMN step_started_at SET NOT NULL;

-- decide_approval_step: identical to 095's body except the 'advanced' branch also
-- stamps step_started_at. Same 7-argument signature, so CREATE OR REPLACE replaces
-- it in place; the REVOKE/GRANT below re-states 103's lock-down explicitly anyway
-- (103 exists because a REVOKE against the wrong signature silently did nothing).
CREATE OR REPLACE FUNCTION public.decide_approval_step(
  p_request_id uuid,
  p_step_id    uuid,
  p_decision   text,
  p_actor_id   uuid,
  p_note       text,
  p_expected_approver_user_id uuid,
  p_expected_approver_role_id uuid
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_status      text;
  v_current     int;
  v_total       int;
  v_step_status text;
  v_step_order  int;
  v_step_user   uuid;
  v_step_role   uuid;
  v_now         timestamptz := now();
BEGIN
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'invalid_decision';
  END IF;

  SELECT status, current_step, total_steps INTO v_status, v_current, v_total
  FROM public.approval_requests WHERE id = p_request_id FOR UPDATE;

  IF v_status IS NULL OR v_status <> 'pending' THEN
    RETURN 'conflict';
  END IF;

  SELECT status, step_order, approver_user_id, approver_role_id
    INTO v_step_status, v_step_order, v_step_user, v_step_role
  FROM public.approval_steps WHERE id = p_step_id AND request_id = p_request_id FOR UPDATE;

  IF v_step_status IS NULL OR v_step_status <> 'pending' OR v_step_order <> v_current THEN
    RETURN 'conflict';
  END IF;

  IF NOT (
    (p_expected_approver_user_id IS NOT NULL AND v_step_user = p_expected_approver_user_id)
    OR (p_expected_approver_role_id IS NOT NULL AND v_step_role = p_expected_approver_role_id)
  ) THEN
    RETURN 'reassigned';
  END IF;

  UPDATE public.approval_steps
  SET status = p_decision, decided_by = p_actor_id, decided_at = v_now, note = p_note
  WHERE id = p_step_id;

  IF p_decision = 'rejected' THEN
    UPDATE public.approval_steps SET status = 'skipped'
    WHERE request_id = p_request_id AND status = 'pending';
    UPDATE public.approval_requests
    SET status = 'rejected', decided_at = v_now, updated_at = v_now
    WHERE id = p_request_id;
    RETURN 'rejected';
  END IF;

  IF v_current < v_total THEN
    UPDATE public.approval_requests
    SET current_step = v_current + 1, updated_at = v_now, step_started_at = v_now,
        reminder_count = 0, escalated_at = NULL
    WHERE id = p_request_id;
    RETURN 'advanced';
  END IF;

  UPDATE public.approval_requests
  SET sending_started_at = v_now, updated_at = v_now
  WHERE id = p_request_id;
  RETURN 'final';
END;
$$;

REVOKE ALL ON FUNCTION public.decide_approval_step(
  uuid, uuid, text, uuid, text, uuid, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decide_approval_step(
  uuid, uuid, text, uuid, text, uuid, uuid
) TO service_role;

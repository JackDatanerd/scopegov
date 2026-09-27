-- ============================================================
-- 095: close the reassign-vs-decide race in decide_approval_step()
--
-- RUN THIS BEFORE DEPLOYING THE MATCHING CODE (lib/approvals/engine.ts's
-- recordApprovalDecision).
--
-- FIX (section-11 independent audit): recordApprovalDecision() checks WHO
-- may decide a step (step.approver_user_id === actor.id, or role
-- membership) with a plain, unlocked SELECT, then calls this function.
-- This function takes FOR UPDATE locks and correctly re-checks
-- status/step_order (closing the double-decide and cancel-vs-decide races
-- migration 069 was built for) but never re-checked approver identity —
-- and reassignApprovalStep() only ever touches approver_user_id/
-- approver_role_id, never status, so a reassignment away from the actor
-- is invisible to the checks this function used to run.
--
-- Sequence that used to succeed: approver X's decision passes the JS
-- eligibility check (reads approver_user_id = X) -> an admin reassigns the
-- SAME still-pending step to Y (UPDATE succeeds, status untouched) -> X's
-- already-in-flight decision reaches this function, which only checked
-- status/step_order (both still fine) and recorded decided_by = X on a
-- step that, as of the reassignment, belonged to Y. The one guarantee
-- reassignment exists to provide -- "take it out of that person's hands"
-- -- didn't hold across this race.
--
-- Fix: the caller now passes the SAME approver_user_id/approver_role_id
-- it validated eligibility against; re-verify that identity here, against
-- the row actually locked by this transaction, not the JS layer's earlier
-- read. A mismatch returns a new 'reassigned' outcome (distinct from
-- 'conflict') so the caller can give a clear, honest error instead of
-- silently recording a decision from someone no longer assigned.
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

  -- The identity check the JS layer already ran, re-run against the row
  -- this transaction actually holds locked. A step assigned to a specific
  -- user is only ever matched by p_expected_approver_user_id; a
  -- role-assigned step only by p_expected_approver_role_id -- exactly
  -- mirroring recordApprovalDecision's own eligibility branch, so a
  -- reassignment (which always clears/replaces one of these two columns)
  -- is caught here even though it never touches status.
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
    SET current_step = v_current + 1, updated_at = v_now, reminder_count = 0, escalated_at = NULL
    WHERE id = p_request_id;
    RETURN 'advanced';
  END IF;

  UPDATE public.approval_requests
  SET sending_started_at = v_now, updated_at = v_now
  WHERE id = p_request_id;
  RETURN 'final';
END;
$$;

-- The old 5-arg signature is gone once the matching code deploys (Postgres
-- allows two overloads to coexist otherwise, and a stale caller silently
-- hitting the unpatched 5-arg version would defeat this fix entirely).
DROP FUNCTION IF EXISTS public.decide_approval_step(uuid, uuid, text, uuid, text);

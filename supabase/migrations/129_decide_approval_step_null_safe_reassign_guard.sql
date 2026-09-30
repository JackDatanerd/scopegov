-- ============================================================
-- 129: decide_approval_step() reassign guard was NULL-unsafe (section-11 pass 1, B1)
--
-- RUN THIS BEFORE (or together with) DEPLOYING; no application code change depends on it, but it is
-- safe to apply at any time -- same signature, same return values, CREATE OR REPLACE in place.
--
-- Migrations 095/110 re-verify, under the row lock, that the step still belongs to the approver the
-- caller checked. The check returned NULL instead of FALSE whenever a step was reassigned between a
-- role and a person, so the stale approver's in-flight decision still landed. Reproduced on Postgres
-- (PGlite): role->person and person->role reassignments returned 'advanced'; person->person and
-- role->role returned 'reassigned'. Everything else in the function is identical to 110.
-- ============================================================

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

  -- FIX (section-11 pass 1, B1): the old guard was
  --   IF NOT ((exp_user IS NOT NULL AND step_user = exp_user) OR (exp_role IS NOT NULL AND step_role = exp_role))
  -- and was NULL-unsafe: when an admin reassigns a step between a ROLE and a PERSON, the column the
  -- caller expected is now NULL, so `step_role = exp_role` is NULL, the whole OR is NULL, NOT NULL is
  -- NULL, and PL/pgSQL treats an IF on NULL as false -- the 'reassigned' return never fired and the
  -- stale approver's decision was recorded on a step that now belonged to someone else. Only
  -- person->person and role->role reassignments were caught. IS DISTINCT FROM is NULL-safe: the step
  -- must still hold EXACTLY the (user, role) pair the caller validated eligibility against.
  IF v_step_user IS DISTINCT FROM p_expected_approver_user_id
     OR v_step_role IS DISTINCT FROM p_expected_approver_role_id THEN
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

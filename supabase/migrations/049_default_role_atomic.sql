-- 049_default_role_atomic.sql
--
-- FIX (deep audit, Team & Invites re-pass): "make this role the default"
-- was two separate, non-transactional statements run from the API route
-- (UPDATE ... SET is_default = false on the old default, then a second
-- INSERT/UPDATE setting the new one) — see app/api/team/roles/route.ts's
-- own history. roles(workspace_id) has a UNIQUE index WHERE is_default =
-- true (migration 001), so the two steps can't simply be reordered or
-- combined into one client-side call either: the new row can't be marked
-- default while the old one still is, and the old one can't be safely
-- unmarked without already knowing the new one will land. If the second
-- step ever failed after the first succeeded (a validation error, a
-- transient DB blip), the workspace was left with ZERO default roles —
-- and accept/route.ts and signup/route.ts both look up the default role
-- with `.single()` and silently fall back to role_id: null on a miss,
-- meaning a member could join mid-race with no role and no permissions
-- at all, with nothing surfacing the failure to an admin.
--
-- Wrapping both updates in one PL/pgSQL function makes them land in a
-- single transaction — either the swap fully succeeds or nothing changes
-- at all, closing the window entirely.
CREATE OR REPLACE FUNCTION public.set_default_role_atomic(
  p_workspace_id uuid,
  p_new_role_id  uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.roles
    WHERE id = p_new_role_id AND workspace_id = p_workspace_id
  ) THEN
    RAISE EXCEPTION 'Role % does not belong to workspace %', p_new_role_id, p_workspace_id;
  END IF;

  UPDATE public.roles
    SET is_default = false, updated_at = now()
    WHERE workspace_id = p_workspace_id
      AND is_default = true
      AND id != p_new_role_id;

  UPDATE public.roles
    SET is_default = true, updated_at = now()
    WHERE id = p_new_role_id;
END;
$$;

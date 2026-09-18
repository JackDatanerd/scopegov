-- ============================================================
-- ScopeGov — Migration 045: fix broken atomic scope-deliverable append
-- + track it in project_scope_snapshot.version
--
-- BUG (deep audit, section 13 — cross-cutting finding #1, regression):
-- migration 043's append_scope_deliverables() has a type mismatch that
-- makes it fail on every real call. project_scope_snapshot.deliverables
-- is `jsonb[]` (a native Postgres ARRAY of jsonb elements — see
-- 001_initial_schema.sql), not a single `jsonb` column holding a JSON
-- array. Migration 043's function body does:
--
--   SET deliverables = COALESCE(deliverables, '[]'::jsonb) || p_added
--
-- `'[]'::jsonb` is a scalar jsonb value, not a jsonb[] array — COALESCE
-- can't reconcile `jsonb[]` and `jsonb`, and Postgres raises a type error
-- at execution time (plpgsql function bodies aren't type-checked until
-- first run, so `CREATE OR REPLACE FUNCTION` succeeded silently). Worse,
-- lib/documents/finalize-co.ts calls this RPC with a bare
-- `await (service as any).rpc(...)`, without capturing `{ data, error }`
-- — supabase-js doesn't throw on a Postgres error, it returns one in
-- `error`, which nothing here ever looks at. So since migration 043
-- shipped, every accepted change order with added_deliverables has been
-- silently failing to add them to the scope snapshot: no thrown
-- exception (the surrounding try/catch never fires), no console.error,
-- no error surfaced to the agency or the client. Guardian keeps
-- classifying against the OLD scope forever — the exact "scope of record
-- silently diverges from what actually happened" failure mode this whole
-- area of the codebase has been hardened against everywhere else.
--
-- Fix: expand the incoming jsonb array (`p_added`, one JSON array value —
-- e.g. `[{"title":"Extra revisions"}]`) into individual jsonb elements
-- with jsonb_array_elements() and collect them into a real jsonb[] via
-- ARRAY(...), so the concatenation is jsonb[] || jsonb[] — a type
-- Postgres actually supports.
--
-- BUG (deep audit, section 13 — cross-cutting finding #2): separately,
-- version — the optimistic-concurrency column
-- app/api/guardian/scope-adjustment/route.ts's compare-and-swap depends
-- on to detect "someone else changed this since I read it" — was never
-- part of 043's fix, and isn't touched by the SOW-signing route's own
-- snapshot write either (see that route's companion fix). That leaves
-- scope-adjustment blind to both of the codebase's other two writers of
-- this column: a CO accepted (or a SOW re-signed) between
-- scope-adjustment's read and its write goes undetected because version
-- never moves, so scope-adjustment's own write then overwrites the CO's
-- or the re-sign's just-landed deliverables with its own stale-read copy.
-- Every writer of this column now advances version, so it's actually the
-- single source of truth for "has this snapshot changed" it was always
-- meant to be. Folded into the same atomic UPDATE as the append itself —
-- no new race introduced.
-- ============================================================

CREATE OR REPLACE FUNCTION public.append_scope_deliverables(
  p_project_id uuid,
  p_added      jsonb,
  p_now        timestamptz
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.project_scope_snapshot
  SET deliverables    = COALESCE(deliverables, '{}'::jsonb[])
                         || ARRAY(SELECT jsonb_array_elements(COALESCE(p_added, '[]'::jsonb))),
      last_updated_at = p_now,
      last_updated_by = 'amendment',
      version         = COALESCE(version, 1) + 1
  WHERE project_id = p_project_id;
END;
$$;

REVOKE ALL ON FUNCTION public.append_scope_deliverables(uuid, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_scope_deliverables(uuid, jsonb, timestamptz) TO service_role;

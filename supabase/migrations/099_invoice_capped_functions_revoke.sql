-- 099_invoice_capped_functions_revoke.sql
--
-- Migration 096 created create_invoice_capped and update_invoice_capped as SECURITY DEFINER
-- functions that take p_workspace_id / p_invoice_id as raw parameters, but never locked them
-- down the way every sibling atomic RPC is (see 059 (A), 088, 093, 097). Postgres grants
-- EXECUTE to PUBLIC on creation, so both were callable through /rest/v1/rpc/<name> with the
-- public anon key — bypassing SEND_INVOICES, project-membership checks, the approval gate,
-- and RLS entirely (create: insert an invoice into any workspace; update: rewrite any draft
-- invoice's title/amount/payment instructions).
--
-- The app only ever calls them through the service-role client
-- (app/api/invoices/route.ts, app/api/invoices/[id]/route.ts), so this changes nothing about
-- how the app itself works.

REVOKE ALL ON FUNCTION public.create_invoice_capped(
  uuid, uuid, text, uuid, numeric, uuid, uuid, uuid, text, numeric, numeric, numeric,
  boolean, jsonb, text, date, text, text, text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_invoice_capped(
  uuid, uuid, text, uuid, numeric, uuid, uuid, uuid, text, numeric, numeric, numeric,
  boolean, jsonb, text, date, text, text, text, uuid
) TO service_role;

REVOKE ALL ON FUNCTION public.update_invoice_capped(
  uuid, uuid, text, uuid, numeric, numeric, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_invoice_capped(
  uuid, uuid, text, uuid, numeric, numeric, jsonb
) TO service_role;

-- ============================================================
-- ScopeGov — Migration 051: revoked_tokens 'expired' reason
--
-- FIX (build, cron/portal audit round): sow-expiry and co-expiry
-- (app/api/cron/{sow,co}-expiry) invalidate a document's signing link by
-- setting its own `token` column to null — unlike decline/withdraw, which
-- ALSO insert a revoked_tokens row (reason: 'declined'/'withdrawn') that
-- survives the token column going away. Once the daily expiry cron nulls
-- the token, the GET routes' revoked-token lookup finds nothing (nothing
-- was ever inserted) AND the direct-by-token lookup finds nothing (the
-- column is null) — so a client revisiting an expired SOW/CO link lands
-- on the generic 'invalid'/'revoked' state instead of the purpose-built
-- 'expired' one, even though the whole point of tracking expires_at and a
-- dedicated 'expired' status/UI state was to give a precise message here.
--
-- This is the steady state, not a race window: any client who revisits an
-- expired link after the once-daily cron has already run (i.e. almost
-- always, in practice) hits it.
--
-- reason only allowed 'withdrawn','declined','superseded','manual' — this
-- widens it so the expiry crons can revoke the same way decline/withdraw
-- already do, closing the gap at its source rather than special-casing
-- null tokens further downstream.
-- ============================================================

ALTER TABLE public.revoked_tokens DROP CONSTRAINT IF EXISTS revoked_tokens_reason_check;
ALTER TABLE public.revoked_tokens ADD CONSTRAINT revoked_tokens_reason_check
  CHECK (reason IN ('withdrawn','declined','superseded','manual','expired'));

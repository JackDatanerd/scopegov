-- supabase/migrations/002_signatures.sql
--
-- Adds storage for drawn signatures:
--   - workspaces.agency_signature_data: the agency's saved signature,
--     drawn once in Settings, auto-applied to every SOW/CO from then on.
--   - sow_documents.client_signature_data / change_orders.client_signature_data:
--     the client's drawn signature captured at the moment they sign/accept.
--
-- Stored as a base64 PNG data URL (text). Signature drawings are small
-- (typically 5-20KB as PNG) — a dedicated storage bucket would be
-- over-engineering for this; text columns are simplest and fine for RLS
-- (same policies already covering these tables apply automatically).

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS agency_signature_data text;

ALTER TABLE public.sow_documents
  ADD COLUMN IF NOT EXISTS client_signature_data text;

ALTER TABLE public.change_orders
  ADD COLUMN IF NOT EXISTS client_signature_data text;

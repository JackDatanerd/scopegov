-- Change orders: the client signer's position and the company they sign on behalf of (mirrors 153 for SOWs).
ALTER TABLE public.change_orders
  ADD COLUMN IF NOT EXISTS accepted_by_title   text,
  ADD COLUMN IF NOT EXISTS accepted_by_company text;
ALTER TABLE public.change_orders
  ADD CONSTRAINT change_orders_signer_len CHECK (
    (accepted_by_title IS NULL OR char_length(accepted_by_title) <= 120) AND
    (accepted_by_company IS NULL OR char_length(accepted_by_company) <= 160));

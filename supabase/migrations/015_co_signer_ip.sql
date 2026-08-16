-- 015_co_signer_ip.sql
-- Doc-completeness audit finding #2: sow_documents.signer_ip has existed
-- since 001_initial_schema.sql and is captured on every SOW signature
-- (see app/api/portal/sow/[token]/sign/route.ts). change_orders never
-- had an equivalent column, and neither the direct-accept nor the
-- countersign portal routes captured an IP at all — so a CO amendment,
-- which is just as legally binding as the original SOW, carried a
-- materially weaker evidentiary trail. Adds the column; the accept and
-- countersign routes are updated in the same pass to populate it.

ALTER TABLE public.change_orders ADD COLUMN IF NOT EXISTS signer_ip text;

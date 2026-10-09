-- 157_co_revised_delivery_date.sql
--
-- A change order could say "+10 days" (timeline_impact_days) but never what the new delivery date is, so the client had to
-- do the arithmetic against a date the CO itself never states. Optional, set by the agency when the timeline moves; shown
-- on the CO next to the day count.
ALTER TABLE public.change_orders ADD COLUMN IF NOT EXISTS revised_delivery_date date;

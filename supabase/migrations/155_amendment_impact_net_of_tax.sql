-- 155_amendment_impact_net_of_tax.sql
--
-- Contract values are NET of tax everywhere in the app (projects.contract_value, invoices.subtotal, the
-- "Contracted value" on every invoice). Amendments were the exception: finalize-co recorded the change order's
-- tax-inclusive TOTAL as financial_impact, so on a taxed workspace the contracted value, the CO's own
-- "Revised Contract Value" and every amendment-summing report mixed net and gross (e.g. $4,000 + $757.75 =
-- "$4,757.75" instead of $4,000 + $700 = $4,700).
--
-- New amendments now record the net subtotal (lib/documents/co-contract-value.ts coNetImpact). This backfills the
-- existing rows from their change order. Only rows whose change order actually carries tax and a stored subtotal are
-- touched; retainer-renewal amendments (impact 0) and untaxed change orders are left exactly as they are. The
-- subtotal is already signed for credit change orders, so credits stay negative.

UPDATE public.amendments a
SET financial_impact = c.subtotal
FROM public.change_orders c
WHERE a.change_order_id = c.id
  AND COALESCE(c.tax_rate, 0) > 0
  AND c.subtotal IS NOT NULL
  AND COALESCE(c.is_retainer_renewal, false) = false
  AND a.financial_impact IS DISTINCT FROM c.subtotal;

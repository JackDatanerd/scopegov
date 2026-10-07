# Final polish pass
- Branded Supabase auth email templates (supabase/email-templates/)
- 2FA recommended instead of forced (MFA_ENFORCEMENT=required restores it); nudges in Settings and Team roster
- Settings > Workspace: helper text moved into info tooltips (components/ui/InfoTip.tsx)
- US-centric examples/placeholders replacing Kenya-specific ones; timezone lists lead with US zones
- Pre-send warning when the client's billing address is empty (SOW + CO), with an Edit client details button
- SOW PDF: localized headers/labels/table vocabulary; aligned signature block with `Name, Position` and company label
- Swahili/other-language drafting prompt: no English glosses, consistent party terms

## Round 2
- Signatory details: workspace signatory name/position (Settings > Billing identity), client signer position + "signing on behalf of" on the portal signing form; printed as `Name, Position` / `CLIENT — Company` on SOW and CO PDFs (migration 153)
- Agency signature now carries a date
- PDFs no longer hyphenate words
- Send warnings: governing law naming only a country; project start date already in the past
- AI drafting prompt: dates always include the year

# Final polish pass
- Branded Supabase auth email templates (supabase/email-templates/)
- 2FA recommended instead of forced (MFA_ENFORCEMENT=required restores it); nudges in Settings and Team roster
- Settings > Workspace: helper text moved into info tooltips (components/ui/InfoTip.tsx)
- US-centric examples/placeholders replacing Kenya-specific ones; timezone lists lead with US zones
- Pre-send warning when the client's billing address is empty (SOW + CO), with an Edit client details button
- SOW PDF: localized headers/labels/table vocabulary; aligned signature block with `Name, Position` and company label
- Swahili/other-language drafting prompt: no English glosses, consistent party terms

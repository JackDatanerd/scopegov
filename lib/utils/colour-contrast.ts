// lib/utils/colour-contrast.ts
//
// FIX (deep audit, client-facing/signing section — feature gap): the workspace's brand colour
// becomes white button text throughout the client portal and every client-facing email (see the
// three portal pages, components/portal/PortalShell.tsx, and lib/email/templates.ts's CTA button
// and highlighted amounts) — but nothing ever checked that white text stays legible on top of it.
// An agency could pick a pale colour in Settings (only a small static swatch was shown, no preview
// of it as an actual button) and hand every client an unreadable "Sign" button, with no way to
// notice until a client actually complained. This is the shared contrast math used by both the
// Settings branding preview (immediate, as the colour is picked — see BrandingTab in
// SettingsClient.tsx) and the branding save route (a persisted warning on the response — see
// app/api/workspace/branding/route.ts), so the two can't drift out of sync on what "too light"
// means.

function srgbToLinear(c: number): number {
  const v = c / 255
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

function relativeLuminance(hex: string): number | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex)
  if (!m) return null
  const int = parseInt(m[1], 16)
  const r = srgbToLinear((int >> 16) & 255)
  const g = srgbToLinear((int >> 8) & 255)
  const b = srgbToLinear(int & 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two #rrggbb hex colours, or null if either one isn't valid. */
export function contrastRatio(hexA: string, hexB: string): number | null {
  const la = relativeLuminance(hexA)
  const lb = relativeLuminance(hexB)
  if (la === null || lb === null) return null
  const lighter = Math.max(la, lb)
  const darker  = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

// White text needs at least this much contrast against the colour behind it to stay legible.
// 3:1 is WCAG's own threshold for bold/large-scale text, which is what these buttons and
// highlighted amounts actually are — not the stricter 4.5:1 for body copy.
export const MIN_WHITE_TEXT_CONTRAST = 3

/** True when white text (as used on portal buttons and email CTAs) would be hard to read against this colour. */
export function isLowContrastForWhiteText(hex: string): boolean {
  const ratio = contrastRatio(hex, '#ffffff')
  return ratio !== null && ratio < MIN_WHITE_TEXT_CONTRAST
}

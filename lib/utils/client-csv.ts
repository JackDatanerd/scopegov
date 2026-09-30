// CSV cells that start with = + - @ are executed as formulas by Excel / Sheets — neutralise them.
//
// FIX (independent pass 2, section 14): the guard prefixed a literal apostrophe to EVERY phone number written in
// international form ("+254 712 345 678" → "'+254 712 345 678"), which is how phone numbers are normally written
// — the whole Phone column of a Nairobi agency's export came out corrupted, and the apostrophe shows up as text
// in Excel/Sheets CSV imports. A phone cell that is nothing but a leading + and digits/spaces/()-. cannot hold a
// function call or a cell reference (no letters), so it is exempt — only for the Phone column, and only for that
// exact shape; anything else in it still gets the guard.
export const SAFE_PHONE = /^\+[\d\s().-]{4,}$/
// FIX (independent pass, section 14 — B3): "+1-555-123-4567" is a VALID arithmetic formula (1 - 555 - 123 - 4567), so a
// spreadsheet computes it and the Phone cell turns into -5244 — silent data loss, worse than a visible apostrophe. A
// plus sign followed by digit groups joined ONLY by hyphens (no space, bracket or dot to make it unparseable) therefore
// keeps the guard. Spaced / bracketed forms ("+254 712 345 678", "+1 (415) 555-0100") are not valid formulas and stay exempt.
const HYPHEN_ONLY_PHONE = /^\+\d+(?:-\d+)+$/
export function csvCell(v: unknown, isPhone = false): string {
  let t = v == null ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(t) && !(isPhone && SAFE_PHONE.test(t) && !HYPHEN_ONLY_PHONE.test(t))) t = `'${t}`
  return `"${t.replace(/"/g, '""')}"`
}


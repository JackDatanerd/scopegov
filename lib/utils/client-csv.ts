// CSV cells that start with = + - @ are executed as formulas by Excel / Sheets — neutralise them.
//
// FIX (independent pass 2, section 14): the guard prefixed a literal apostrophe to EVERY phone number written in
// international form ("+254 712 345 678" → "'+254 712 345 678"), which is how phone numbers are normally written
// — the whole Phone column of a Nairobi agency's export came out corrupted, and the apostrophe shows up as text
// in Excel/Sheets CSV imports. A phone cell that is nothing but a leading + and digits/spaces/()-. cannot hold a
// function call or a cell reference (no letters), so it is exempt — only for the Phone column, and only for that
// exact shape; anything else in it still gets the guard.
export const SAFE_PHONE = /^\+[\d\s().-]{4,}$/
export function csvCell(v: unknown, isPhone = false): string {
  let t = v == null ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(t) && !(isPhone && SAFE_PHONE.test(t))) t = `'${t}`
  return `"${t.replace(/"/g, '""')}"`
}


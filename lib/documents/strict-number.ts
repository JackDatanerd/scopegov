// lib/documents/strict-number.ts
//
// CO-8: Number("0x10") is 16, Number("1e2") is 100 and Number("0b11") is 3, so a numeric STRING that reached a change
// order's money, tax, timeline or renewal-term fields through the API was read in bases and notations nobody typed in a
// price box. The editor only ever sends plain decimals; the API now accepts only those (optional sign, digits, optional
// fraction), and everything else reads as "not a number" so the caller's existing validation refuses it.

const PLAIN_DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/

/** A plain decimal string -> its number; NaN for anything else (blank, hex, exponent, Infinity, units, ...). */
export function parsePlainDecimal(value: string): number {
  const t = value.trim()
  return PLAIN_DECIMAL.test(t) ? Number(t) : NaN
}

// lib/utils/csv.ts
//
// Shared CSV cell encoder for every export in the app.
//
// FIX (Reports & Audit re-pass #3): the previous copies (one in
// api/reports/export, one in api/reports/audit-export) prefixed `'` to ANY
// string starting with `-`, so a legitimately negative number (a scope
// reduction's CO impact, an old/new value) exported as the text `'-500`
// instead of a number. They also missed the two other leading characters
// OWASP lists as formula triggers: TAB (0x09) and CR (0x0D).
//
// Rules now:
//  - real JS numbers / bigint / booleans are never touched (they can't
//    carry a payload, and prefixing them corrupts the value);
//  - a string that is *only* a plain signed decimal ("-500", "+12.5") is
//    left alone for the same reason;
//  - any other string whose first character is = + - @ TAB or CR gets a
//    leading single quote so Excel/Sheets treat it as text;
//  - RFC 4180 quoting is applied on top.

const NUMERIC_STRING = /^[+-]?\d+(\.\d+)?$/
const FORMULA_LEAD = /^[=+\-@\t\r]/

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value)
  }
  let str = String(value)
  if (FORMULA_LEAD.test(str) && !NUMERIC_STRING.test(str)) str = `'${str}`
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',')
}

/** UTF-8 BOM so Excel opens non-ASCII names (é, ł, Swahili, etc.) correctly. */
export const CSV_BOM = '\uFEFF'

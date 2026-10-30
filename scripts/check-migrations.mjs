#!/usr/bin/env node
// scripts/check-migrations.mjs
//
// Migrations here are run by hand in the Supabase SQL editor, so nothing records which ones ran. This reads every
// supabase/migrations/*.sql in order, works out which database objects the whole set should leave behind (tables,
// columns, functions, indexes, triggers, policies, types, views — with later DROP / RENAME statements applied), and
// writes ONE SQL query to paste into the Supabase SQL editor. The query returns a row for every expected object that
// does NOT exist, tagged with the most recent migration that defines it. Zero rows = everything is there.
//
//   node scripts/check-migrations.mjs                -> writes supabase/verify-migrations.generated.sql + prints a summary
//
// Limits (a presence check, not a diff): it cannot see that a CREATE OR REPLACE FUNCTION body is the latest version,
// that a data backfill ran, GRANTs, RLS enabled/disabled, or anything created inside DO blocks / function bodies. If a
// migration shows up missing, run it (they are written to be re-runnable) and run the check again.

import fs from 'node:fs'
import path from 'node:path'

const dir = path.join(process.cwd(), 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()

const strip = sql => sql
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/--[^\n]*/g, ' ')
  .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' $$ ')   // function bodies and DO blocks
  .replace(/'(?:[^']|'')*'/g, "''")                    // string literals

const id = s => s.replace(/"/g, '').replace(/^public\./i, '').toLowerCase()   // keeps other schemas, e.g. auth.users
const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)`
const QNAME = String.raw`(?:${IDENT}\.)?${IDENT}`

const objs = new Map()      // key -> { kind, name, parent, mig }
const put = (kind, name, parent, mig) => objs.set(`${kind}|${parent || ''}|${name}`, { kind, name, parent: parent || '', mig })
const del = (kind, name, parent) => objs.delete(`${kind}|${parent || ''}|${name}`)
const dropColumnsOf = table => { for (const [k, v] of objs) if (v.kind === 'column' && v.parent === table) objs.delete(k) }

function splitTop(body) {
  const parts = []; let depth = 0, cur = ''
  for (const ch of body) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(cur); cur = '' } else cur += ch
  }
  if (cur.trim()) parts.push(cur)
  return parts
}

for (const f of files) {
  const mig = f.replace(/\.sql$/, '')
  const sql = strip(fs.readFileSync(path.join(dir, f), 'utf8'))
  for (const stmt of sql.split(';')) {
    let m
    if ((m = stmt.match(new RegExp(String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QNAME})\s*\(([\s\S]*)\)`, 'i')))) {
      const t = id(m[1]); put('table', t, '', mig)
      for (const part of splitTop(m[2])) {
        const c = part.trim().match(new RegExp(`^(${IDENT})\\s+\\S`))
        if (!c) continue
        const name = id(c[1])
        if (/^(constraint|primary|unique|foreign|check|exclude|like)$/i.test(name)) continue
        put('column', name, t, mig)
      }
      continue
    }
    if ((m = stmt.match(new RegExp(String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(${QNAME})`, 'i')))) { put('table', id(m[1]), '', mig); continue }
    if ((m = stmt.match(new RegExp(String.raw`DROP\s+(?:TABLE|VIEW)\s+(?:IF\s+EXISTS\s+)?(${QNAME})`, 'i')))) { const t = id(m[1]); del('table', t); dropColumnsOf(t); continue }
    if ((m = stmt.match(new RegExp(String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QNAME})([\s\S]*)`, 'i')))) {
      const t = id(m[1]), rest = m[2]
      for (const a of rest.matchAll(new RegExp(String.raw`ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})`, 'gi'))) put('column', id(a[1]), t, mig)
      for (const a of rest.matchAll(new RegExp(String.raw`DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(${IDENT})`, 'gi'))) del('column', id(a[1]), t)
      const rn = rest.match(new RegExp(String.raw`RENAME\s+COLUMN\s+(${IDENT})\s+TO\s+(${IDENT})`, 'i'))
      if (rn) { del('column', id(rn[1]), t); put('column', id(rn[2]), t, mig) }
      const rt = rest.match(new RegExp(String.raw`^\s*RENAME\s+TO\s+(${IDENT})`, 'i'))
      if (rt) { del('table', t); dropColumnsOf(t); put('table', id(rt[1]), '', mig) }
      continue
    }
    if ((m = stmt.match(new RegExp(String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(${QNAME})\s*\(`, 'i')))) { put('function', id(m[1]), '', mig); continue }
    if ((m = stmt.match(new RegExp(String.raw`DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(${QNAME})`, 'i')))) { del('function', id(m[1])); continue }
    if ((m = stmt.match(new RegExp(String.raw`CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s+ON`, 'i')))) { put('index', id(m[1]), '', mig); continue }
    if ((m = stmt.match(new RegExp(String.raw`DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(${QNAME})`, 'i')))) { del('index', id(m[1])); continue }
    if ((m = stmt.match(new RegExp(String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(${IDENT})[\s\S]*?\sON\s+(${QNAME})`, 'i')))) { put('trigger', id(m[1]), id(m[2]), mig); continue }
    if ((m = stmt.match(new RegExp(String.raw`DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?(${IDENT})\s+ON\s+(${QNAME})`, 'i')))) { del('trigger', id(m[1]), id(m[2])); continue }
    if ((m = stmt.match(new RegExp(String.raw`CREATE\s+POLICY\s+(${IDENT})\s+ON\s+(${QNAME})`, 'i')))) { put('policy', id(m[1]), id(m[2]), mig); continue }
    if ((m = stmt.match(new RegExp(String.raw`DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?(${IDENT})\s+ON\s+(${QNAME})`, 'i')))) { del('policy', id(m[1]), id(m[2])); continue }
    if ((m = stmt.match(new RegExp(String.raw`CREATE\s+TYPE\s+(${QNAME})`, 'i')))) { put('type', id(m[1]), '', mig); continue }
  }
}

const rows = [...objs.values()].sort((a, b) => a.mig.localeCompare(b.mig) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
const q = s => `'${s.replace(/'/g, "''")}'`
const values = rows.map(r => `  (${q(r.mig)}, ${q(r.kind)}, ${q(r.parent)}, ${q(r.name)})`).join(',\n')

const out = `-- Generated by scripts/check-migrations.mjs from ${files.length} migration files (${rows.length} expected objects).
-- Paste into the Supabase SQL editor and run. Every row returned is an object that SHOULD exist but does NOT.
-- No rows = all present. "migration" is the most recent file that defines it: re-run that file, then run this again.
WITH expected(migration, kind, parent, name) AS (VALUES
${values}
)
SELECT e.migration, e.kind, e.parent AS "on_table", e.name AS missing_object
FROM expected e
WHERE NOT CASE e.kind
  WHEN 'table'    THEN to_regclass('public.' || quote_ident(e.name)) IS NOT NULL
  WHEN 'column'   THEN EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = e.parent AND c.column_name = e.name)
  WHEN 'function' THEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = e.name)
  WHEN 'index'    THEN EXISTS (SELECT 1 FROM pg_indexes i WHERE i.schemaname = 'public' AND i.indexname = e.name)
  WHEN 'trigger'  THEN EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname = (CASE WHEN position('.' in e.parent) > 0 THEN split_part(e.parent, '.', 1) ELSE 'public' END) AND c.relname = (CASE WHEN position('.' in e.parent) > 0 THEN split_part(e.parent, '.', 2) ELSE e.parent END) AND t.tgname = e.name)
  WHEN 'policy'   THEN EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = e.parent AND p.policyname = e.name)
  WHEN 'type'     THEN EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = e.name)
  ELSE true END
ORDER BY e.migration, e.kind, e.name;
`
const target = path.join(process.cwd(), 'supabase', 'verify-migrations.generated.sql')
fs.writeFileSync(target, out)
const by = {}; for (const r of rows) by[r.kind] = (by[r.kind] || 0) + 1
console.log(`Read ${files.length} migrations -> ${rows.length} expected objects`, by)
console.log(`Wrote ${path.relative(process.cwd(), target)} — paste it into the Supabase SQL editor.`)

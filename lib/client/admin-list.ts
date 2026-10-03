'use client'
// lib/client/admin-list.ts
//
// FIX (Admin panel independent audit — B5): the admin list pages fired a fetch per keystroke with no sequencing, so
// a slow earlier response could overwrite a newer one (the table showed results for a query that was no longer in the
// box), and a non-OK response (401/500) was swallowed — leaving the previous rows on screen, or "No users match" for
// what was really a server error. This hook debounces input, drops stale responses (AbortController + a request
// counter) and exposes the failure as `error`.
import { useCallback, useEffect, useRef, useState } from 'react'

export function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value)
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t) }, [value, ms])
  return v
}

export function useAdminList<T>(url: string | null, pick: (json: any) => { rows: T[]; total: number }) {
  const [rows, setRows] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const ctrlRef = useRef<AbortController | null>(null)
  const pickRef = useRef(pick); pickRef.current = pick

  const load = useCallback(async () => {
    if (!url) return
    const mine = ++seq.current
    const ctrl = new AbortController()
    ctrlRef.current?.abort()
    ctrlRef.current = ctrl
    setLoading(true)
    try {
      const res = await fetch(url, { signal: ctrl.signal })
      const json = await res.json().catch(() => ({}))
      if (mine !== seq.current) return // a newer request superseded this one
      if (!res.ok) {
        setError(res.status === 401 ? 'Your session expired — reload the page and sign in again.' : (json?.error || `Request failed (${res.status}).`))
        return
      }
      const out = pickRef.current(json)
      setRows(out.rows); setTotal(out.total); setError(null)
    } catch (e: any) {
      if (e?.name === 'AbortError' || mine !== seq.current) return
      setError('Network error — could not reach the server.')
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [url])

  useEffect(() => { load() }, [load])
  return { rows, total, loading, error, reload: load }
}

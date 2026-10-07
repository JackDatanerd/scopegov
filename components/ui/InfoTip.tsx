// components/ui/InfoTip.tsx
// Small "i" button that reveals helper text on hover, keyboard focus or tap, so forms stay compact.
'use client'
import { useState, useRef, useEffect, useId } from 'react'

export default function InfoTip({ text, children }: { text?: string; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const id = useId()

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent | TouchEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('touchstart', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('touchstart', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-block', marginLeft: 6, verticalAlign: 'middle' }}
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" aria-label="More information" aria-expanded={open} aria-describedby={open ? id : undefined}
        onClick={e => { e.preventDefault(); e.stopPropagation(); setOpen(o => !o) }}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        style={{ background: 'none', border: 'none', padding: 0, margin: 0, cursor: 'help', color: 'var(--text-3)', lineHeight: 1, fontSize: 14 }}>
        <i className="ti ti-info-circle" aria-hidden="true" />
      </button>
      {open && (
        <span role="tooltip" id={id}
          style={{ position: 'absolute', zIndex: 50, left: -8, top: '100%', marginTop: 6, width: 260, maxWidth: '70vw',
            background: 'var(--surface, #fff)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 6,
            boxShadow: '0 4px 14px rgba(0,0,0,.12)', padding: '8px 10px', fontSize: 12, fontWeight: 400, lineHeight: 1.5,
            textTransform: 'none', letterSpacing: 'normal', textAlign: 'left', whiteSpace: 'normal' }}>
          {children ?? text}
        </span>
      )}
    </span>
  )
}

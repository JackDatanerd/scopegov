// components/portal/PortalShell.tsx
//
// FIX (bug — focus jumps every keystroke on CO/Invoice client portal
// pages): app/portal/co/[token]/page.tsx and app/portal/invoice/[token]/
// page.tsx each defined their own `PortalShell` component INSIDE the page
// function body. A component declared inside another component's render
// is a fresh function reference on every render, so React can't tell it's
// "the same" component across renders — it tears down and remounts the
// entire subtree (including every input, textarea, and the SignaturePad)
// every time parent state changes, which is every keystroke. Any element
// with `autoFocus` in that subtree regains focus on remount, which is
// exactly the "type one letter, cursor jumps to the amount field" /
// "click Confirm, cursor jumps back to full name" symptoms — the field
// itself is fine, it's getting yanked back to whatever autoFocus'd on
// mount. SOW portal (app/portal/sow/[token]/page.tsx) renders its header
// inline instead of as a nested component, which is why it never showed
// this: same SignaturePad, same autoFocus usage, no bug — confirms this
// isn't a SignaturePad or textarea issue, just the inline-component shell.
//
// Fix: hoist the shell to module scope (here) so its identity is stable
// across renders — React then correctly diffs and preserves the subtree,
// input focus and all. Shared between CO and Invoice portals since they
// were byte-for-byte the same component; parameterized on the one thing
// that differed (icon).
import type { ReactNode } from 'react'

interface Props {
  children:   ReactNode
  logoUrl?:   string | null
  agencyName?: string | null
  accent:     string
  icon?:      string // tabler icon class suffix, e.g. 'ti-scale', 'ti-receipt'
}

export default function PortalShell({ children, logoUrl, agencyName, accent, icon = 'ti-scale' }: Props) {
  return (
    <div className="portal-root">
      <div className="portal-header">
        <div className="portal-header-brand" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {logoUrl ? (
            <img src={logoUrl} alt={agencyName || 'Agency'} style={{ height: 26, objectFit: 'contain' }} />
          ) : (
            <>
              <div style={{ width: 26, height: 26, background: accent, borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <i className={`ti ${icon}`} style={{ fontSize: 14, color: '#FFF' }} />
              </div>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{agencyName || 'ScopeGov'}</span>
            </>
          )}
        </div>
        <div style={{ fontSize: 11, color: '#909090', display: 'flex', alignItems: 'center', gap: 5 }}>
          <i className="ti ti-lock" style={{ fontSize: 11 }} /> Secured by ScopeGov
        </div>
      </div>
      {children}
    </div>
  )
}

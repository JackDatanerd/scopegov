/** Balance-scale logo mark used by the homepage nav and footer. Same glyph as the favicon set in /public (the shield belongs to ScopeShield). BrandMark.tsx stays as-is for the calculator and legal shells. */
export default function HomeMark({ className }: { className?: string }) {
  return (
    <span className={className} aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 64 64" fill="#fff">
        <rect x="29.5" y="10" width="5" height="38" rx="2.5" />
        <rect x="18" y="47" width="28" height="5.5" rx="2.75" />
        <rect x="8" y="19" width="48" height="5" rx="2.5" />
        <circle cx="32" cy="12" r="4.5" />
        <path d="M5 35h18a9 9 0 0 1-18 0zM41 35h18a9 9 0 0 1-18 0z" />
        <path d="M9 24 6.5 35M9 24l7.5 11M55 24l2.5 11M55 24l-7.5 11" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
      </svg>
    </span>
  )
}

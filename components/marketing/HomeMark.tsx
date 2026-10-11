/** Shield-and-check logo mark used by the homepage nav and footer. (BrandMark.tsx stays as-is for the calculator and legal shells.) */
export default function HomeMark({ className }: { className?: string }) {
  return (
    <span className={className} aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M8 1.5 2.5 3.6v4.1c0 3.2 2.3 5.6 5.5 6.8 3.2-1.2 5.5-3.6 5.5-6.8V3.6L8 1.5Z" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="m5.6 8 1.7 1.7L10.6 6.4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

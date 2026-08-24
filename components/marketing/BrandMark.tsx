export function BrandMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 26 26" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="26" height="26" rx="6" fill="#1A5C3A" />
      <path d="M6 11h14M13 11.5v6.5M9.5 16.5h7" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M7 11 A3 1.6 0 0 0 13 11" fill="none" stroke="#fff" strokeWidth="1.1" />
      <path d="M13 11 A3 1.6 0 0 0 19 11" fill="none" stroke="#fff" strokeWidth="1.1" />
    </svg>
  )
}

// components/help/HelpLink.tsx
//
// A small "?" that opens the matching help article, placed next to the screen or setting it explains.
// - Opens in a NEW tab, so help never costs someone the form or wizard they are in the middle of.
// - Signed-in screens only: /help sits behind the app layout, so never render this on a public page (portal, calculator, marketing).
// - `slug` must be a published article in lib/help. tests/help-contextual-links.test.ts checks every slug used anywhere in the app.
// - Pure markup, no state and no registry import, so it adds nothing to client bundles.

import s from '@/styles/help.module.css'

interface Props {
  /** Slug of a published help article. */
  slug: string
  /** Tooltip and screen-reader text. Say what the article answers: "Help: why a send is blocked". */
  title?: string
  /** Optional visible text. Without it the link is an icon only. */
  label?: string
}

export default function HelpLink({ slug, title, label }: Props) {
  const text = title || 'Open the help article'
  return (
    <a
      href={`/help/${slug}`}
      target="_blank"
      rel="noopener noreferrer"
      className={label ? `${s.helpLink} ${s.helpLinkLabel}` : s.helpLink}
      title={text}
      aria-label={label ? `${label} (opens in a new tab)` : `${text} (opens in a new tab)`}
    >
      <i className="ti ti-help-circle" aria-hidden="true" />
      {label ? <span>{label}</span> : null}
    </a>
  )
}

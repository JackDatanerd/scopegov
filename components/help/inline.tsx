// components/help/inline.tsx
//
// Renders the two bits of inline markup help text may contain (see lib/help/types.ts): **UI label** and [text](/in-app/path).
// Everything else is plain text. Output is React nodes, never raw HTML, so article content cannot inject markup, and a link
// can only point inside the app (it must start with a single "/").

import Link from 'next/link'
import { Fragment } from 'react'

export type InlinePart =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'link'; text: string; href: string }

const TOKEN = /(\*\*[^*]+\*\*|\[[^\]]+\]\(\/(?!\/)[^)\s]*\))/g

export function parseInline(input: string): InlinePart[] {
  const parts: InlinePart[] = []
  for (const piece of String(input ?? '').split(TOKEN)) {
    if (!piece) continue
    if (piece.startsWith('**') && piece.endsWith('**') && piece.length > 4) {
      parts.push({ type: 'bold', text: piece.slice(2, -2) })
      continue
    }
    const link = /^\[([^\]]+)\]\((\/(?!\/)[^)\s]*)\)$/.exec(piece)
    if (link) { parts.push({ type: 'link', text: link[1], href: link[2] }); continue }
    parts.push({ type: 'text', text: piece })
  }
  return parts
}

export function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((p, i) => (
        <Fragment key={i}>
          {p.type === 'bold' ? <strong>{p.text}</strong>
            : p.type === 'link' ? <Link href={p.href}>{p.text}</Link>
            : p.text}
        </Fragment>
      ))}
    </>
  )
}

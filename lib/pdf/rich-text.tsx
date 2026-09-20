// lib/pdf/rich-text.tsx
//
// FIX (doc-quality audit, Aug 2026): SowEditor.tsx's Tiptap toolbar lets
// the user apply Bold, Italic, bullet lists, and numbered lists — but the
// old renderer.tsx `stripHtml()` flattened all of it to plain text before
// it ever reached the PDF: <strong>/<em> were unwrapped to their bare
// text, and both <ul> and <ol> collapsed to the same "• " prefix (so a
// numbered list of steps loses its numbers on the actual signed
// document). This was silent data loss — what the freelancer designed in
// the editor was not what the client saw. This module replaces that path
// for section body content only (table cells go through
// sanitizePlainText and are never HTML in the first place).
//
// The content here always originates from lib/utils/sanitize.ts's
// RICH_TEXT_OPTIONS allowlist, so the tag set handled below is exhaustive
// by construction, not a guess at what Tiptap might someday emit.

import React from 'react'
import { Text, View, Link } from '@react-pdf/renderer'
import { PDF_FONT } from '@/lib/pdf/fonts'

interface InlineRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  code?: boolean
  // FIX (section-9 audit, 9-B3): `a` was matched as an inline tag and
  // then thrown away — the tag contributed no styling and its href was
  // never read, so every hyperlink in a SOW section rendered as bare,
  // dead text on the signed PDF. lib/utils/sanitize.ts explicitly
  // allows `a[href]` (and force-adds rel/target), so links are a
  // supported, sanitized part of section content; the PDF was the only
  // place they silently disappeared.
  href?: string
}

// `&amp;` must be decoded LAST: decoding it first turned the literal text
// "&lt;" (stored as "&amp;lt;") into "<".
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&amp;/g, '&')
}

// Capture the whole opening tag so an <a>'s href survives into the run.
const INLINE_TAG_RE = /<(\/?)(strong|b|em|i|u|s|strike|code|br|a)((?:\s[^>]*)?)>|([^<]+)/gi
const HREF_RE = /href\s*=\s*("([^"]*)"|'([^']*)')/i

function collectInlineRuns(html: string): InlineRun[] {
  const runs: InlineRun[] = []
  const stack: Partial<InlineRun>[] = [{}]
  let m: RegExpExecArray | null
  INLINE_TAG_RE.lastIndex = 0
  while ((m = INLINE_TAG_RE.exec(html))) {
    const [, closing, tag, attrs, text] = m
    if (text !== undefined) {
      // FIX (section-9 audit, 9-B6): this dropped every whitespace-only
      // run, so `<strong>A</strong> <em>B</em>` rendered as "AB" — the
      // space between two formatted words vanished from the signed
      // document. (The condition was also redundant: `trim().length === 0`
      // and `!/\S/` test the same thing.) Collapse a whitespace-only run
      // to a single space and keep it; only drop it at the very start of
      // a block, where it would indent the line.
      if (!/\S/.test(text)) {
        if (runs.length === 0) continue
        runs.push({ text: ' ', ...stack[stack.length - 1] })
        continue
      }
      runs.push({ text: decodeEntities(text), ...stack[stack.length - 1] })
    } else if (tag) {
      const t = tag.toLowerCase()
      if (t === 'br') { runs.push({ text: '\n' }); continue }
      if (!closing) {
        const next: Partial<InlineRun> = { ...stack[stack.length - 1] }
        if (t === 'strong' || t === 'b') next.bold = true
        if (t === 'em' || t === 'i') next.italic = true
        if (t === 'u') next.underline = true
        if (t === 's' || t === 'strike') next.strike = true
        if (t === 'code') next.code = true
        if (t === 'a') {
          const href = HREF_RE.exec(attrs || '')
          const url  = href?.[2] ?? href?.[3]
          // sanitizeRichText already restricts schemes to http/https/mailto.
          if (url) next.href = url
        }
        stack.push(next)
      } else if (stack.length > 1) {
        stack.pop()
      }
    }
  }
  return runs
}

interface Block { tag: string; inner: string; depth?: number }

// FIX (section-9 audit, 9-B5 + 9-B4): the old implementation was a single
// regex with a non-greedy `([\s\S]*?)</\1>` body:
//
//   1. 9-B5 — a <ul> containing a nested <ul> terminated at the INNER
//      </ul>, so the outer list was truncated mid-way and the remaining
//      items silently vanished. Tiptap's StarterKit supports nesting via
//      Tab, so this was reachable from the editor's own toolbar.
//   2. 9-B4 — only regex matches were emitted, and the bare-text fallback
//      only ran when NOTHING matched. So `Intro sentence.<p>Body</p>`
//      dropped "Intro sentence." entirely, as did any text sitting
//      between two blocks. sanitize-html does not wrap loose text nodes,
//      and the AI prompt's "no raw text outside tags" rule is advisory —
//      parseDelimitedSections never validates it. Silent content loss on
//      a document someone signs.
//
// Replaced with a small scanner that tracks nesting depth for list tags
// and emits loose text between blocks as its own paragraph.
// FIX (section-9 re-pass): 'pre' was missing here even though
// lib/utils/sanitize.ts's allowlist (which this file's own comment
// elsewhere claims to be exhaustive against) includes both 'pre' and
// 'code' — and Tiptap's StarterKit (used unconfigured in
// components/sow/SowEditor.tsx) reaches its CodeBlock extension via a
// markdown input rule even with no toolbar button for it. Without 'pre'
// recognized as a block tag, a code block's raw
// `<pre><code>...</code></pre>` fell into the loose-text fallback below
// and downgraded to plain inline monospace text merged into whichever
// paragraph it landed next to, losing the block entirely.
const BLOCK_OPEN_RE = /<(p|h1|h2|h3|h4|blockquote|ul|ol|pre)(?:\s[^>]*)?>/i
const LIST_TAGS = new Set(['ul', 'ol'])

function findBlockEnd(html: string, from: number, tag: string): number {
  // Returns the index just past the matching close tag, honouring nesting.
  const openRe  = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'gi')
  const closeRe = new RegExp(`</${tag}\\s*>`, 'gi')
  let depth  = 1
  let cursor = from

  while (depth > 0) {
    closeRe.lastIndex = cursor
    const close = closeRe.exec(html)
    if (!close) return html.length // unclosed — take the rest

    openRe.lastIndex = cursor
    let nextOpen = openRe.exec(html)
    while (nextOpen && nextOpen.index < close.index) {
      depth++
      openRe.lastIndex = nextOpen.index + nextOpen[0].length
      nextOpen = openRe.exec(html)
    }

    depth--
    cursor = close.index + close[0].length
    if (depth === 0) return cursor
  }
  return cursor
}

function splitBlocks(html: string): Block[] {
  const blocks: Block[] = []
  let rest = html
  let offset = 0

  while (offset < html.length) {
    const slice = html.slice(offset)
    const open  = BLOCK_OPEN_RE.exec(slice)

    if (!open) {
      // Trailing loose text — emit it rather than dropping it (9-B4).
      const tail = slice
      if (/\S/.test(tail.replace(/<[^>]+>/g, ''))) blocks.push({ tag: 'p', inner: tail })
      break
    }

    // Loose text before this block (9-B4).
    const lead = slice.slice(0, open.index)
    if (/\S/.test(lead.replace(/<[^>]+>/g, ''))) blocks.push({ tag: 'p', inner: lead })

    const tag        = open[1].toLowerCase()
    const contentAt  = offset + open.index + open[0].length
    const endAt      = findBlockEnd(html, contentAt, tag)
    const closeLen   = (html.slice(0, endAt).match(new RegExp(`</${tag}\\s*>$`, 'i')) || [''])[0].length
    const inner      = html.slice(contentAt, endAt - closeLen)

    blocks.push({ tag, inner })
    offset = endAt
  }

  void rest
  return blocks
}

// FIX (section-9 audit, 9-B5, second half): `LI_RE` had the same
// non-greedy problem — an <li> containing a nested list ended at the
// inner </li>, corrupting the item. Depth-aware scan, and each item
// keeps any nested list it contains so RichText can render it indented
// instead of throwing it away.
function splitListItems(inner: string): string[] {
  const items: string[] = []
  const openRe = /<li(?:\s[^>]*)?>/gi
  let m: RegExpExecArray | null

  openRe.lastIndex = 0
  while ((m = openRe.exec(inner))) {
    const contentAt = m.index + m[0].length
    const endAt     = findBlockEnd(inner, contentAt, 'li')
    const closeLen  = (inner.slice(0, endAt).match(/<\/li\s*>$/i) || [''])[0].length
    items.push(inner.slice(contentAt, endAt - closeLen))
    openRe.lastIndex = endAt
  }
  return items
}

/** Splits an <li>'s content into its own inline text and any nested lists. */
function splitListItemContent(item: string): { text: string; nested: Block[] } {
  const nested: Block[] = []
  let text = ''
  let offset = 0

  const NESTED_RE = /<(ul|ol)(?:\s[^>]*)?>/i
  while (offset < item.length) {
    const slice = item.slice(offset)
    const open  = NESTED_RE.exec(slice)
    if (!open) { text += slice; break }

    text += slice.slice(0, open.index)
    const tag       = open[1].toLowerCase()
    const contentAt = offset + open.index + open[0].length
    const endAt     = findBlockEnd(item, contentAt, tag)
    const closeLen  = (item.slice(0, endAt).match(new RegExp(`</${tag}\\s*>$`, 'i')) || [''])[0].length
    nested.push({ tag, inner: item.slice(contentAt, endAt - closeLen) })
    offset = endAt
  }

  return { text, nested }
}

function renderRuns(runs: InlineRun[]) {
  return runs.map((r, i) => {
    if (r.text === '\n') return '\n'
    const style: any = {}
    if (r.bold && r.italic)      style.fontFamily = PDF_FONT.boldItalic
    else if (r.bold)             style.fontFamily = PDF_FONT.bold
    else if (r.italic)           style.fontFamily = PDF_FONT.italic
    if (r.code)                  style.fontFamily = 'Courier'
    if (r.underline && r.strike) style.textDecoration = 'underline line-through'
    else if (r.underline)        style.textDecoration = 'underline'
    else if (r.strike)           style.textDecoration = 'line-through'
    if (r.href) {
      return <Link key={i} src={r.href} style={{ ...style, color: '#1A5C3A', textDecoration: 'underline' }}>{r.text}</Link>
    }
    return <Text key={i} style={style}>{r.text}</Text>
  })
}

/**
 * FIX (section-9 audit, 9-B5): renders a list, recursing into nested
 * lists instead of discarding them. Nested levels indent and switch
 * bullet glyph the way a word processor does, so a two-level list in the
 * editor survives into the signed PDF as a two-level list.
 */
const NESTED_BULLETS = ['\u2022', '\u25E6', '\u25AA']

function ListBlock({ tag, inner, style, depth }: { tag: string; inner: string; style: any; depth: number }) {
  const items = splitListItems(inner)
  return (
    <View style={{ marginBottom: depth === 0 ? 6 : 0, marginLeft: depth === 0 ? 0 : 14 }}>
      {items.map((item, j) => {
        const { text, nested } = splitListItemContent(item)
        return (
          <View key={j} style={{ marginBottom: 2 }}>
            <View style={{ flexDirection: 'row' }}>
              <Text style={[style, { width: 16 }]}>
                {tag === 'ol' ? `${j + 1}.` : NESTED_BULLETS[Math.min(depth, NESTED_BULLETS.length - 1)]}
              </Text>
              <Text style={[style, { flex: 1 }]}>{renderRuns(collectInlineRuns(text))}</Text>
            </View>
            {nested.map((n, k) => (
              <ListBlock key={k} tag={n.tag} inner={n.inner} style={style} depth={depth + 1} />
            ))}
          </View>
        )
      })}
    </View>
  )
}

/** Renders sanitized section HTML as react-pdf blocks, preserving bold/italic/underline/strike and rendering <ol> with real numbers instead of collapsing to bullets. */
export function RichText({ html, style }: { html: string | null | undefined; style: any }) {
  if (!html || !html.trim()) return null
  const blocks = splitBlocks(html)

  // Fallback: content isn't wrapped in a recognized block tag at all
  // (shouldn't happen given sanitizeRichText's allowlist, but content can
  // predate that guarantee) — render as a single paragraph rather than
  // silently dropping it.
  if (blocks.length === 0) {
    return <Text style={[style, { marginBottom: 6 }]}>{renderRuns(collectInlineRuns(html))}</Text>
  }

  return (
    <>
      {blocks.map((b, i) => {
        if (b.tag === 'ul' || b.tag === 'ol') {
          return <ListBlock key={i} tag={b.tag} inner={b.inner} style={style} depth={0} />
        }
        if (b.tag === 'pre') {
          // Literal/verbatim content — strip a wrapping <code> tag if
          // present (StarterKit emits <pre><code>...</code></pre>) and
          // render one line per literal newline, rather than running it
          // through collectInlineRuns (which would also happily apply
          // bold/italic marks inside a code block, which isn't the
          // intent here).
          const codeText = decodeEntities(
            b.inner.replace(/^<code(?:\s[^>]*)?>/i, '').replace(/<\/code>\s*$/i, '')
          )
          return (
            <View key={i} style={{
              backgroundColor: '#F9F8F5', border: '1 solid #E5E1D8', borderRadius: 4,
              paddingTop: 8, paddingBottom: 8, paddingLeft: 10, paddingRight: 10, marginBottom: 6,
            }}>
              {codeText.split('\n').map((line, j) => (
                <Text key={j} style={[style, { fontFamily: 'Courier', fontSize: 9 }]}>{line || ' '}</Text>
              ))}
            </View>
          )
        }
        const headingSize: Record<string, number> = { h1: 14, h2: 13, h3: 12, h4: 11 }
        const blockStyle = headingSize[b.tag]
          ? [style, { fontFamily: PDF_FONT.bold, fontSize: headingSize[b.tag] }]
          : b.tag === 'blockquote'
            ? [style, { fontFamily: PDF_FONT.italic, paddingLeft: 10, borderLeft: '2 solid #E5E1D8' }]
            : style
        return <Text key={i} style={[blockStyle, { marginBottom: 6 }]}>{renderRuns(collectInlineRuns(b.inner))}</Text>
      })}
    </>
  )
}

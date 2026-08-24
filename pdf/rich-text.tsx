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
import { Text, View } from '@react-pdf/renderer'

interface InlineRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  code?: boolean
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

const INLINE_TAG_RE = /<(\/?)(strong|b|em|i|u|s|strike|code|br|a)(?:\s[^>]*)?>|([^<]+)/gi

function collectInlineRuns(html: string): InlineRun[] {
  const runs: InlineRun[] = []
  const stack: Partial<InlineRun>[] = [{}]
  let m: RegExpExecArray | null
  INLINE_TAG_RE.lastIndex = 0
  while ((m = INLINE_TAG_RE.exec(html))) {
    const [, closing, tag, text] = m
    if (text !== undefined) {
      if (text.trim().length === 0 && !/\S/.test(text)) continue
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
        stack.push(next)
      } else if (stack.length > 1) {
        stack.pop()
      }
    }
  }
  return runs
}

interface Block { tag: string; inner: string }

const BLOCK_RE = /<(p|h1|h2|h3|h4|blockquote)(?:\s[^>]*)?>([\s\S]*?)<\/\1>|<(ul|ol)(?:\s[^>]*)?>([\s\S]*?)<\/\3>/gi

function splitBlocks(html: string): Block[] {
  const blocks: Block[] = []
  let m: RegExpExecArray | null
  BLOCK_RE.lastIndex = 0
  while ((m = BLOCK_RE.exec(html))) {
    if (m[1]) blocks.push({ tag: m[1].toLowerCase(), inner: m[2] })
    else if (m[3]) blocks.push({ tag: m[3].toLowerCase(), inner: m[4] })
  }
  return blocks
}

const LI_RE = /<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/gi

function splitListItems(inner: string): string[] {
  const items: string[] = []
  let m: RegExpExecArray | null
  LI_RE.lastIndex = 0
  while ((m = LI_RE.exec(inner))) items.push(m[1])
  return items
}

function renderRuns(runs: InlineRun[]) {
  return runs.map((r, i) => {
    if (r.text === '\n') return '\n'
    const style: any = {}
    if (r.bold && r.italic)      style.fontFamily = 'Helvetica-BoldOblique'
    else if (r.bold)             style.fontFamily = 'Helvetica-Bold'
    else if (r.italic)           style.fontFamily = 'Helvetica-Oblique'
    if (r.code)                  style.fontFamily = 'Courier'
    if (r.underline && r.strike) style.textDecoration = 'underline line-through'
    else if (r.underline)        style.textDecoration = 'underline'
    else if (r.strike)           style.textDecoration = 'line-through'
    return <Text key={i} style={style}>{r.text}</Text>
  })
}

/** Renders sanitized section HTML as react-pdf blocks, preserving bold/italic/underline/strike and rendering <ol> with real numbers instead of collapsing to bullets. */
export function RichText({ html, style }: { html: string; style: any }) {
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
          const items = splitListItems(b.inner)
          return (
            <View key={i} style={{ marginBottom: 6 }}>
              {items.map((item, j) => (
                <View key={j} style={{ flexDirection: 'row', marginBottom: 2 }}>
                  <Text style={[style, { width: 16 }]}>{b.tag === 'ol' ? `${j + 1}.` : '•'}</Text>
                  <Text style={[style, { flex: 1 }]}>{renderRuns(collectInlineRuns(item))}</Text>
                </View>
              ))}
            </View>
          )
        }
        const headingSize: Record<string, number> = { h1: 14, h2: 13, h3: 12, h4: 11 }
        const blockStyle = headingSize[b.tag]
          ? [style, { fontFamily: 'Helvetica-Bold', fontSize: headingSize[b.tag] }]
          : b.tag === 'blockquote'
            ? [style, { fontFamily: 'Helvetica-Oblique', paddingLeft: 10, borderLeft: '2 solid #E5E1D8' }]
            : style
        return <Text key={i} style={[blockStyle, { marginBottom: 6 }]}>{renderRuns(collectInlineRuns(b.inner))}</Text>
      })}
    </>
  )
}

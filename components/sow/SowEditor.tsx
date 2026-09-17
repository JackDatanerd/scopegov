// components/sow/SowEditor.tsx
// FIX 4A: Preview PDF href changed from hardcoded /api/pdf/sow/draft to
// /api/pdf/sow/${sowId} — was always returning 404 for the actual SOW.

'use client'
import { useState, useCallback, useRef, useEffect } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { countWords, formatCurrency } from '@/lib/utils/format'
import { isTableSection, SOW_TABLE_SCHEMAS, blankRow, columnLabel, parseTableAmount, type SowTableRow, type SowTableSectionId } from '@/lib/sow/table-schema'
import { SOW_SECTION_DEFS } from '@/lib/ai/sow-content'

interface Section {
  id: string; title: string; content: string; table?: SowTableRow[]; visible: boolean; order: number
}

interface Props {
  sowId:   string
  sections: Section[]
  isLocked: boolean
  canSend:  boolean
  canEdit:  boolean
  // Contract value + currency, so the Payment Schedule editor can show a
  // running total against the figure send-time validation checks it
  // against (9-G6).
  contractValue?: number
  currency?: string
  language?: string
  // The client's feedback when this draft was spawned by a
  // request-changes (9-G8).
  changeRequest?: { note: string; fromVersion: number; requestedBy?: string } | null
}

// FIX (section-9 audit, 9-G10): 'governing_law' and 'oos' added. Generate
// hard-blocks a SOW outright when the workspace has no governing law set,
// on the grounds that it's "a real, material legal term of the contract"
// — and then this list let the agency hide the whole Governing Law
// section anyway. Out of Scope is the load-bearing section of a
// scope-governance product and was likewise optional. Kept in sync with
// REQUIRED_SECTION_IDS in app/api/sow/[id]/route.ts, which now enforces
// the same list server-side (it previously enforced nothing at all).
const REQUIRED_SECTIONS = ['parties', 'deliverables', 'oos', 'payment', 'governing_law', 'signature']

// FIX (section-9 audit, 9-G9): this was a hardcoded duplicate of
// SOW_SECTION_DEFS' ordering, and the nav below renders only ids present
// in BOTH it and the stored sections. Any section added to
// SOW_SECTION_DEFS without someone remembering to also add it here became
// invisible and uneditable — which is exactly what happened to
// 'payment_schedule' for every SOW created before it shipped, leaving
// those SOWs permanently unsendable under a milestones structure. Derive
// it from the single source of truth so the two can't drift again.
const SECTION_ORDER = [...SOW_SECTION_DEFS].sort((a, b) => a.order - b.order).map(d => d.id)

export default function SowEditor({ sowId, sections: initialSections, isLocked, canSend, canEdit, contractValue, currency, language, changeRequest }: Props) {
  const [sections,      setSections]      = useState<Section[]>(
    [...initialSections].sort((a, b) => a.order - b.order)
  )
  const [activeSection,    setActiveSection]    = useState<string>(sections[0]?.id || 'overview')
  const [saveStatus,       setSaveStatus]       = useState<'idle'|'saving'|'saved'|'error'>('idle')
  const [regenLoading,     setRegenLoading]     = useState<string | null>(null)
  const [regenInstruction, setRegenInstruction] = useState('')
  const [showRegen,        setShowRegen]        = useState<string | null>(null)
  // FIX (re-audit, data-loss finding): this used to be a single shared
  // timer, so editing section A then switching to section B inside the
  // 1.5s debounce window would clearTimeout() A's pending save entirely —
  // never sent to the server, no error, no indication anything was lost.
  // Keyed per-section so switching sections can no longer cancel another
  // section's in-flight save.
  const saveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const current = sections.find(s => s.id === activeSection) || sections[0]

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: 'Start writing this section…' }),
    ],
    content:  current?.content || '',
    editable: canEdit && !isLocked,
    onUpdate: ({ editor }) => {
      if (isLocked || !canEdit) return
      const html = editor.getHTML()
      setSections(prev => prev.map(s => s.id === activeSection ? { ...s, content: html } : s))
      scheduleAutosave(activeSection, { content: html })
    },
  }, [activeSection])

  const switchSection = useCallback((sectionId: string) => {
    const target = sections.find(s => s.id === sectionId)
    if (!target) return
    setActiveSection(sectionId)
    editor?.commands.setContent(target.content || '')
  }, [sections, editor])

  function scheduleAutosave(sectionId: string, payload: { content: string } | { table: SowTableRow[] }) {
    const existing = saveTimers.current.get(sectionId)
    if (existing) clearTimeout(existing)
    setSaveStatus('saving')
    const timer = setTimeout(async () => {
      saveTimers.current.delete(sectionId)
      try {
        const res = await fetch(`/api/sow/${sowId}`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ sectionId, ...payload }),
        })
        setSaveStatus(res.ok ? 'saved' : 'error')
        if (res.ok && saveTimers.current.size === 0) setTimeout(() => setSaveStatus('idle'), 2000)
      } catch {
        setSaveStatus('error')
      }
    }, 1500)
    saveTimers.current.set(sectionId, timer)
  }

  // FIX (re-audit, data-loss finding): warn before the tab closes/navigates
  // away while a section's edit hasn't been persisted yet — previously a
  // user could type, leave within the 1.5s debounce window, and lose the
  // edit with zero indication anything went wrong.
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (saveTimers.current.size > 0) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  function updateTable(sectionId: string, rows: SowTableRow[]) {
    setSections(prev => prev.map(s => s.id === sectionId ? { ...s, table: rows } : s))
    scheduleAutosave(sectionId, { table: rows })
  }

  async function handleRegen(sectionId: string) {
    setRegenLoading(sectionId)
    try {
      const sec = sections.find(s => s.id === sectionId)
      const res = await fetch('/api/sow/regenerate-section', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          sowId, sectionId,
          sectionTitle:   sec?.title,
          currentContent: sec?.content || '',
          instruction:    regenInstruction.trim() || null,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setSections(prev => prev.map(s => s.id === sectionId ? { ...s, content: json.content } : s))
      if (sectionId === activeSection) editor?.commands.setContent(json.content)
      scheduleAutosave(sectionId, { content: json.content })
      setShowRegen(null); setRegenInstruction('')
    } catch (err) {
      console.error('Regen failed:', err)
    } finally { setRegenLoading(null) }
  }

  // FIX (section-9 audit, 9-B10): this was fire-and-forget — the local
  // state flipped and the response was never inspected. A 403 (no
  // EDIT_SOW), a 409 (pending approval) or the new required-section 400
  // all left the editor showing a section as hidden while it was still
  // visible in the document the client signs. Roll the optimistic flip
  // back and surface the failure through the existing save indicator.
  async function toggleVisibility(sectionId: string) {
    if (REQUIRED_SECTIONS.includes(sectionId)) return
    const previous = sections
    const next = sections.map(s => s.id === sectionId ? { ...s, visible: !s.visible } : s)
    setSections(next)
    setSaveStatus('saving')
    try {
      const res = await fetch(`/api/sow/${sowId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ sectionId, visible: next.find(s => s.id === sectionId)?.visible }),
      })
      if (!res.ok) { setSections(previous); setSaveStatus('error'); return }
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2000)
    } catch {
      setSections(previous)
      setSaveStatus('error')
    }
  }

  const isTable = current ? isTableSection(current.id) : false

  // Table sections (Deliverables/Timeline/Roles) don't get the rich-text
  // toolbar or the AI "Improve" wand — regenerate-section only knows how
  // to rewrite prose, and Bold/Italic/lists don't mean anything inside a
  // table cell. They still get the save-status indicator and the
  // show/hide toggle, same as every other section.
  const toolbar = (editor || isTable) ? (
    <div className="editor-toolbar">
      {!isTable && [
        { label: 'B',  cmd: () => editor!.chain().focus().toggleBold().run(),         active: editor!.isActive('bold') },
        { label: 'I',  cmd: () => editor!.chain().focus().toggleItalic().run(),       active: editor!.isActive('italic') },
        { label: '≡',  cmd: () => editor!.chain().focus().toggleBulletList().run(),   active: editor!.isActive('bulletList') },
        { label: '1.', cmd: () => editor!.chain().focus().toggleOrderedList().run(),  active: editor!.isActive('orderedList') },
      ].map((btn, i) => (
        <button key={i} type="button"
          className={btn.active ? 'is-active' : ''}
          onClick={btn.cmd}
          style={{
            fontWeight:  btn.label === 'B' ? 700 : 400,
            fontStyle:   btn.label === 'I' ? 'italic' : 'normal',
          }}>
          {btn.label}
        </button>
      ))}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className={`save-status ${saveStatus}`}>
          {saveStatus === 'saving' && <><span className="spin spin-dark" style={{ width: 10, height: 10 }} /> Saving</>}
          {saveStatus === 'saved'  && <><i className="ti ti-check" style={{ fontSize: 11, color: 'var(--green)' }} /> Saved</>}
          {saveStatus === 'error'  && <><i className="ti ti-alert-circle" style={{ fontSize: 11 }} /> Save failed</>}
        </span>
        {!isLocked && canEdit && current && !REQUIRED_SECTIONS.includes(current.id) && (
          <button type="button" className="btn btn-ghost btn-xs"
            onClick={() => toggleVisibility(current.id)}
            title={current.visible ? 'Hide section' : 'Show section'}>
            <i className={`ti ${current.visible ? 'ti-eye' : 'ti-eye-off'}`} style={{ fontSize: 11 }} />
          </button>
        )}
        {!isTable && !isLocked && canEdit && (
          <button type="button" className="btn btn-ghost btn-xs"
            onClick={() => setShowRegen(showRegen === current?.id ? null : current?.id || null)}>
            <i className="ti ti-wand" style={{ fontSize: 11 }} /> Improve
          </button>
        )}
      </div>
    </div>
  ) : null

  const wordCount = countWords(current?.content || '')
  const rowCount   = current?.table?.length || 0

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 500 }}>
      {/* Section nav */}
      <div style={{ width: 200, minWidth: 200, borderRight: '1px solid var(--border)', padding: '12px 0', overflowY: 'auto' }}>
        {SECTION_ORDER
          .map(id => sections.find(s => s.id === id))
          .filter(Boolean)
          .map((section) => {
            const s = section!
            return (
              <button key={s.id} onClick={() => switchSection(s.id)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  width: '100%', padding: '7px 14px', border: 'none',
                  borderLeft: `2px solid ${activeSection === s.id ? 'var(--green)' : 'transparent'}`,
                  color: !s.visible ? 'var(--text-4)' : activeSection === s.id ? 'var(--green)' : 'var(--text-2)',
                  fontSize: 12, fontWeight: activeSection === s.id ? 500 : 400,
                  cursor: 'pointer', textAlign: 'left',
                  background: activeSection === s.id ? 'var(--green-lt)' : 'transparent',
                }}>
                <span>{s.title}</span>
                {REQUIRED_SECTIONS.includes(s.id)
                  ? <span style={{ fontSize: 9, color: 'var(--text-4)' }}>req</span>
                  : !s.visible
                    ? <i className="ti ti-eye-off" style={{ fontSize: 10, color: 'var(--text-4)' }} />
                    : null}
              </button>
            )
          })}
      </div>

      {/* Editor */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* FIX (section-9 audit, 9-G8): when a client requests changes,
            the portal clones the SOW into a fresh draft — but their actual
            feedback only ever reached an email, a notification body and
            the audit log. Whoever opened this draft to act on it had no
            record inside the document of what was asked for. The note is
            carried on metadata.changeRequest now; show it. */}
        {changeRequest?.note && (
          <div style={{
            padding: '10px 16px', borderBottom: '1px solid var(--border)',
            background: 'var(--amber-lt, #FDF6E3)', display: 'flex', gap: 10, alignItems: 'flex-start',
          }}>
            <i className="ti ti-message-circle" style={{ fontSize: 14, color: 'var(--amber)', marginTop: 1 }} />
            <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-2)' }}>
              <strong>{changeRequest.requestedBy || 'The client'}</strong> requested changes on v{changeRequest.fromVersion}:
              <div style={{ marginTop: 3, color: 'var(--text)' }}>{changeRequest.note}</div>
            </div>
          </div>
        )}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{current?.title}</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
              {isTable ? `${rowCount} row${rowCount === 1 ? '' : 's'}` : `${wordCount} words`}
            </div>
          </div>
          {isLocked && (
            <span className="pill pill-amber" style={{ fontSize: 10 }}>
              <i className="ti ti-lock" style={{ fontSize: 10 }} /> Locked after sending
            </span>
          )}
        </div>

        {showRegen === current?.id && !isLocked && (
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)', display: 'flex', gap: 8 }}>
            <input className="finp"
              style={{ flex: 1, fontSize: 12, padding: '6px 10px' }}
              placeholder="Optional: instruction (e.g. 'make it more concise', 'add 2 more deliverables')"
              value={regenInstruction}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRegenInstruction(e.target.value)}
              onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter' && current) handleRegen(current.id) }}
            />
            <button className="btn btn-primary btn-sm"
              onClick={() => current && handleRegen(current.id)}
              disabled={!!regenLoading}>
              {regenLoading === current?.id
                ? <><span className="spin" /> Improving…</>
                : <><i className="ti ti-wand" style={{ fontSize: 12 }} /> Improve</>}
            </button>
            <button className="btn btn-ghost btn-sm"
              onClick={() => { setShowRegen(null); setRegenInstruction('') }}>
              Cancel
            </button>
          </div>
        )}

        <div className="editor-wrap" style={{ flex: 1, border: 'none', borderRadius: 0, display: 'flex', flexDirection: 'column', overflowY: isTable ? 'auto' : undefined }}>
          {!isLocked && canEdit && toolbar}
          {isTable && current && (
            <TableSectionEditor
              sectionId={current.id as SowTableSectionId}
              rows={current.table || []}
              editable={canEdit && !isLocked}
              onChange={(rows) => updateTable(current.id, rows)}
              contractValue={contractValue}
              currency={currency}
              language={language}
            />
          )}
          {!isTable && editor && (
            <EditorContent
              editor={editor}
              className="editor-body"
              style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', minHeight: 300 }}
            />
          )}
          {!isTable && (!editor || (isLocked || !canEdit)) && (
            <div
              style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', fontSize: 13, lineHeight: 1.75, color: 'var(--text-2)' }}
              dangerouslySetInnerHTML={{ __html: current?.content || '<p style="color:var(--text-4)">No content</p>' }}
            />
          )}
        </div>

        {!isLocked && canSend && (
          <div style={{ padding: '14px 16px', borderTop: '1px solid var(--border)', background: 'var(--surface-2)', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            {/* FIX 4A: was hardcoded /api/pdf/sow/draft — always 404 */}
            <a href={`/api/pdf/sow/${sowId}`} target="_blank" className="btn btn-ghost btn-sm">
              <i className="ti ti-download" style={{ fontSize: 12 }} /> Preview PDF
            </a>
            {/* FIX (section-9 audit, 9-B14): there used to be a second
                "Send to client" button here behind an `onSend` prop the
                editor page never passed, so it never rendered — dead
                markup pretending to be an action. Send lives in the page's
                top bar, which is the only place it has ever worked from. */}
          </div>
        )}
      </div>
    </div>
  )
}
// ── Table section editor (Deliverables / Timeline / Roles) ──────────────
// Cell edits are debounced through the same autosave path as prose
// (scheduleAutosave in the parent), so this only needs to report the full
// row array upward on every keystroke — no separate save state to manage.

function TableSectionEditor({
  sectionId, rows, editable, onChange, contractValue, currency, language,
}: {
  sectionId: SowTableSectionId
  rows: SowTableRow[]
  editable: boolean
  onChange: (rows: SowTableRow[]) => void
  contractValue?: number
  currency?: string
  language?: string
}) {
  const schema = SOW_TABLE_SCHEMAS[sectionId]

  // FIX (section-9 audit, 9-G6): api/sow/[id]/send hard-blocks a
  // milestones SOW unless the Payment Schedule foots to the contract
  // value within a cent — and this editor showed no running total, no
  // contract value, and no variance. The only way to discover a mismatch
  // was to hit Send and read the error. Amounts are free text (and now
  // parsed tolerantly, so "1,500" counts), so show the arithmetic as it's
  // typed.
  const showsTotals = sectionId === 'payment_schedule' && typeof contractValue === 'number'
  const scheduleTotal = showsTotals
    ? rows.reduce((sum, r) => sum + (parseTableAmount(r.amount) ?? 0), 0)
    : 0
  const unreadable = showsTotals
    ? rows.filter(r => String(r.milestone || '').trim() && parseTableAmount(r.amount) === null).length
    : 0
  const variance = showsTotals ? Math.round((scheduleTotal - (contractValue as number)) * 100) / 100 : 0
  const footsExactly = showsTotals && Math.abs(variance) < 0.01 && unreadable === 0

  function updateCell(rowIndex: number, key: string, value: string) {
    const next = rows.map((r, i) => i === rowIndex ? { ...r, [key]: value } : r)
    onChange(next)
  }

  function addRow() {
    onChange([...rows, blankRow(sectionId)])
  }

  function removeRow(rowIndex: number) {
    onChange(rows.filter((_, i) => i !== rowIndex))
  }

  function moveRow(rowIndex: number, dir: -1 | 1) {
    const target = rowIndex + dir
    if (target < 0 || target >= rows.length) return
    const next = [...rows]
    ;[next[rowIndex], next[target]] = [next[target], next[rowIndex]]
    onChange(next)
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
      {rows.length === 0 ? (
        <div style={{
          textAlign: 'center', padding: '32px 16px', color: 'var(--text-4)',
          fontSize: 13, border: '1px dashed var(--border)', borderRadius: 6,
        }}>
          {schema.emptyRowLabel}
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr>
              {schema.columns.map(col => (
                <th key={col.key} style={{
                  textAlign: col.align || 'left', padding: '0 8px 6px',
                  fontSize: 10, fontWeight: 600, color: 'var(--text-3)',
                  textTransform: 'uppercase', letterSpacing: '.04em',
                }}>
                  {columnLabel(col, language)}
                </th>
              ))}
              {editable && <th style={{ width: 64 }} />}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                {schema.columns.map(col => (
                  <td key={col.key} style={{ padding: '6px 8px', verticalAlign: 'top' }}>
                    {col.options ? (
                      <select
                        className="finp"
                        style={{ width: '100%', fontSize: 12.5, padding: '5px 6px' }}
                        value={row[col.key] || col.options[col.options.length - 1]}
                        disabled={!editable}
                        onChange={(e) => updateCell(i, col.key, e.target.value)}
                      >
                        {col.options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                      </select>
                    ) : (
                      <textarea
                        className="finp"
                        rows={1}
                        style={{
                          width: '100%', fontSize: 12.5, padding: '5px 6px', resize: 'vertical',
                          textAlign: col.align || 'left', minHeight: 30,
                        }}
                        value={row[col.key] || ''}
                        disabled={!editable}
                        onChange={(e) => updateCell(i, col.key, e.target.value)}
                      />
                    )}
                  </td>
                ))}
                {editable && (
                  <td style={{ padding: '6px 4px', whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                    <button type="button" className="btn btn-ghost btn-xs" title="Move up"
                      onClick={() => moveRow(i, -1)} disabled={i === 0}>
                      <i className="ti ti-chevron-up" style={{ fontSize: 11 }} />
                    </button>
                    <button type="button" className="btn btn-ghost btn-xs" title="Move down"
                      onClick={() => moveRow(i, 1)} disabled={i === rows.length - 1}>
                      <i className="ti ti-chevron-down" style={{ fontSize: 11 }} />
                    </button>
                    <button type="button" className="btn btn-ghost btn-xs" title="Remove row"
                      onClick={() => removeRow(i)}>
                      <i className="ti ti-trash" style={{ fontSize: 11, color: 'var(--red)' }} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editable && (
        <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} onClick={addRow}>
          <i className="ti ti-plus" style={{ fontSize: 12 }} /> Add row
        </button>
      )}

      {showsTotals && (
        <div style={{
          marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)', fontSize: 12.5,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', color: 'var(--text-2)' }}>
            <span>Schedule total</span>
            <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
              {formatCurrency(scheduleTotal, currency || 'USD')}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', color: 'var(--text-3)' }}>
            <span>Contract value</span>
            <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
              {formatCurrency(contractValue as number, currency || 'USD')}
            </span>
          </div>
          <div style={{
            display: 'flex', justifyContent: 'space-between', padding: '6px 0 0',
            marginTop: 6, borderTop: '1px solid var(--surface-2)', fontWeight: 600,
            color: footsExactly ? 'var(--green)' : 'var(--red)',
          }}>
            <span>
              {unreadable > 0
                ? `${unreadable} amount${unreadable === 1 ? '' : 's'} not a number`
                : footsExactly
                  ? 'Matches the contract value'
                  : `${variance > 0 ? 'Over' : 'Under'} by`}
            </span>
            {unreadable === 0 && !footsExactly && (
              <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
                {formatCurrency(Math.abs(variance), currency || 'USD')}
              </span>
            )}
            {footsExactly && <i className="ti ti-check" style={{ fontSize: 13 }} />}
          </div>
          {!footsExactly && (
            <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6, lineHeight: 1.5 }}>
              The schedule has to add up to the contract value before this SOW can be sent.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

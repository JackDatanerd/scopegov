// components/sow/SowEditor.tsx
// FIX 4A: Preview PDF href changed from hardcoded /api/pdf/sow/draft to
// /api/pdf/sow/${sowId} — was always returning 404 for the actual SOW.

'use client'
import { useState, useCallback, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { sowSectionLabel, countWords } from '@/lib/utils/format'
import { isTableSection, SOW_TABLE_SCHEMAS, blankRow, type SowTableRow, type SowTableSectionId } from '@/lib/sow/table-schema'

interface Section {
  id: string; title: string; content: string; table?: SowTableRow[]; visible: boolean; order: number
}

interface Props {
  sowId:   string
  sections: Section[]
  isLocked: boolean
  onSend?:  () => void
  canSend:  boolean
  canEdit:  boolean
}

const REQUIRED_SECTIONS = ['parties', 'deliverables', 'payment', 'signature']
const SECTION_ORDER = ['parties','overview','deliverables','oos','timeline','roles','assumptions','payment','revisions','ip','confidentiality','termination','governing_law','dispute','signature']

export default function SowEditor({ sowId, sections: initialSections, isLocked, onSend, canSend, canEdit }: Props) {
  const [sections,      setSections]      = useState<Section[]>(
    [...initialSections].sort((a, b) => a.order - b.order)
  )
  const [activeSection,    setActiveSection]    = useState<string>(sections[0]?.id || 'overview')
  const [saveStatus,       setSaveStatus]       = useState<'idle'|'saving'|'saved'|'error'>('idle')
  const [regenLoading,     setRegenLoading]     = useState<string | null>(null)
  const [regenInstruction, setRegenInstruction] = useState('')
  const [showRegen,        setShowRegen]        = useState<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    if (saveTimer.current) clearTimeout(saveTimer.current)
    setSaveStatus('saving')
    saveTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/sow/${sowId}`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ sectionId, ...payload }),
        })
        setSaveStatus(res.ok ? 'saved' : 'error')
        if (res.ok) setTimeout(() => setSaveStatus('idle'), 2000)
      } catch { setSaveStatus('error') }
    }, 1500)
  }

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

  async function toggleVisibility(sectionId: string) {
    if (REQUIRED_SECTIONS.includes(sectionId)) return
    const next = sections.map(s => s.id === sectionId ? { ...s, visible: !s.visible } : s)
    setSections(next)
    await fetch(`/api/sow/${sowId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sectionId, visible: next.find(s => s.id === sectionId)?.visible }),
    })
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
            {onSend && (
              <button className="btn btn-primary btn-sm" onClick={onSend}>
                <i className="ti ti-send" style={{ fontSize: 12 }} /> Send to client
              </button>
            )}
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
  sectionId, rows, editable, onChange,
}: {
  sectionId: SowTableSectionId
  rows: SowTableRow[]
  editable: boolean
  onChange: (rows: SowTableRow[]) => void
}) {
  const schema = SOW_TABLE_SCHEMAS[sectionId]

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
                  {col.label}
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
    </div>
  )
}

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
  // FIX (section-9 re-audit): api/pdf/sow/[id] now 403s a viewer without
  // VIEW_FINANCIALS (see that route's comment) — the editor's own
  // "Preview PDF" link needs this to stop linking to a route that will
  // now always fail for them, same fix as the wrapper page's link.
  canViewFinancials?: boolean
  // Contract value + currency, so the Payment Schedule editor can show a
  // running total against the figure send-time validation checks it
  // against (9-G6).
  contractValue?: number
  currency?: string
  language?: string
  // The client's feedback when this draft was spawned by a
  // request-changes (9-G8).
  changeRequest?: { note: string; fromVersion: number; requestedBy?: string } | null
  // FIX (section-9 audit, 9-G4 — feature gap): metadata.msaReference has
  // been read and rendered on the PDF masthead (renderer.tsx,
  // api/pdf/sow/[id], api/portal/sow/[token]/pdf, .../sign) since a prior
  // pass, but nothing anywhere ever let an agency actually SET it — the
  // field was permanently unreachable. This is the write side: an
  // optional free-text field, autosaved the same way section content is.
  msaReference?: string | null
  // Lets the parent page force every pending edit to be written (and confirm it was) before it
  // acts on the document — Send used to fire with up to 1.5s of typing still unsaved.
  registerFlush?: (flush: () => Promise<boolean>) => void
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

export default function SowEditor({ sowId, sections: initialSections, isLocked, canSend, canEdit, canViewFinancials, contractValue, currency, language, changeRequest, msaReference, registerFlush }: Props) {
  const [sections,      setSections]      = useState<Section[]>(
    [...initialSections].sort((a, b) => a.order - b.order)
  )
  // FIX (section-9 audit, 9-G4 — feature gap): see the Props comment above.
  const [msaRef,        setMsaRef]        = useState(msaReference || '')
  const [msaSaveStatus, setMsaSaveStatus] = useState<'idle'|'saving'|'saved'|'error'>('idle')
  const msaSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // FIX (section-9 re-audit, independent pass): holds whatever value is
  // waiting on msaSaveTimer's debounce (or was last written to the
  // server), so flush() below can persist it directly instead of only
  // knowing a timer exists.
  const msaPendingValue = useRef<string | null>(null)
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
  type SavePayload = { content: string } | { table: SowTableRow[] }
  // Edits waiting on the debounce, edits whose last save FAILED (kept so they can be retried
  // rather than forgotten), and a single chain so saves from this tab run strictly in order.
  const pendingSaves = useRef<Map<string, SavePayload>>(new Map())
  const failedSaves  = useRef<Map<string, SavePayload>>(new Map())
  const saveChain    = useRef<Promise<unknown>>(Promise.resolve())
  const inFlight     = useRef(0)
  const [saveError,   setSaveError]   = useState('')
  const [regenError,  setRegenError]  = useState('')
  const [regenNotice, setRegenNotice] = useState('')
  const [regenUndo,   setRegenUndo]   = useState<{ sectionId: string; content: string } | null>(null)

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

  const refreshSaveStatus = useCallback(() => {
    if (saveTimers.current.size > 0 || inFlight.current > 0) { setSaveStatus('saving'); return }
    // One "Saved" used to overwrite an earlier failure for a different section, hiding lost edits.
    if (failedSaves.current.size > 0) { setSaveStatus('error'); return }
    setSaveError('')
    setSaveStatus('saved')
    setTimeout(() => {
      if (saveTimers.current.size === 0 && failedSaves.current.size === 0 && inFlight.current === 0) setSaveStatus('idle')
    }, 2000)
  }, [])

  const persist = useCallback((sectionId: string, payload: SavePayload): Promise<boolean> => {
    const run = async (): Promise<boolean> => {
      inFlight.current++
      try {
        const res = await fetch(`/api/sow/${sowId}`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ sectionId, ...payload }),
        })
        if (res.ok) { failedSaves.current.delete(sectionId); return true }
        const json = await res.json().catch(() => ({} as any))
        failedSaves.current.set(sectionId, payload)
        setSaveError(json?.error || 'Save failed')
        return false
      } catch {
        failedSaves.current.set(sectionId, payload)
        setSaveError('Network error — your changes are not saved yet')
        return false
      } finally {
        inFlight.current--
        refreshSaveStatus()
      }
    }
    const next = saveChain.current.then(run, run)
    saveChain.current = next
    return next as Promise<boolean>
  }, [sowId, refreshSaveStatus])

  function scheduleAutosave(sectionId: string, payload: SavePayload) {
    const existing = saveTimers.current.get(sectionId)
    if (existing) clearTimeout(existing)
    pendingSaves.current.set(sectionId, payload)
    failedSaves.current.delete(sectionId) // superseded by this newer edit
    setSaveStatus('saving')
    const timer = setTimeout(() => {
      saveTimers.current.delete(sectionId)
      const latest = pendingSaves.current.get(sectionId)
      pendingSaves.current.delete(sectionId)
      if (latest) void persist(sectionId, latest)
    }, 1500)
    saveTimers.current.set(sectionId, timer)
  }

  // Extracted from scheduleMsaAutosave's setTimeout body so flush() below can call the same
  // persistence logic directly, on demand, instead of only being able to wait for the timer.
  const persistMsaRef = useCallback(async (value: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/sow/${sowId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ msaReference: value }),
      })
      setMsaSaveStatus(res.ok ? 'saved' : 'error')
      if (res.ok) {
        // Only clear the pending marker if nothing newer has been typed since — a flush that
        // raced a fresh keystroke must not erase the record of that newer, still-unsaved edit.
        if (msaPendingValue.current === value) msaPendingValue.current = null
        setTimeout(() => setMsaSaveStatus('idle'), 2000)
      }
      return res.ok
    } catch {
      setMsaSaveStatus('error')
      return false
    }
  }, [sowId])

  // Writes everything outstanding NOW (pending edits and previously-failed ones) and reports
  // whether every section is safely stored.
  //
  // FIX (section-9 re-audit, independent pass — data-loss finding): this
  // used to only flush saveTimers/pendingSaves/failedSaves (section
  // content/tables) — msaSaveTimer's own separate 800ms-debounced autosave
  // for the MSA Reference field was never included. handleSend calls this
  // specifically so "everything typed in the last moments is stored before
  // the server snapshots the document" — typing an MSA reference and
  // hitting Send within that 800ms window sent and locked the document
  // while the reference was still only sitting in the debounce, so the
  // pending save then fired against an already-locked SOW, was silently
  // 409'd, and the entered reference was lost with no visible error. Flush
  // it the same way the section saves are: cancel the timer and persist
  // the pending value directly.
  const flush = useCallback(async (): Promise<boolean> => {
    saveTimers.current.forEach(t => clearTimeout(t))
    saveTimers.current.clear()
    const todo = new Map<string, SavePayload>()
    failedSaves.current.forEach((payload, id) => todo.set(id, payload))
    pendingSaves.current.forEach((payload, id) => todo.set(id, payload)) // newer edit wins over a failed older one
    pendingSaves.current.clear()
    const entries: Array<[string, SavePayload]> = []
    todo.forEach((payload, id) => entries.push([id, payload]))
    let ok = true
    for (const [id, payload] of entries) { if (!(await persist(id, payload))) ok = false }
    await saveChain.current

    if (msaSaveTimer.current) {
      clearTimeout(msaSaveTimer.current)
      msaSaveTimer.current = null
    }
    if (msaPendingValue.current !== null) {
      if (!(await persistMsaRef(msaPendingValue.current))) ok = false
    }

    return ok && failedSaves.current.size === 0
  }, [persist, persistMsaRef])

  useEffect(() => { registerFlush?.(flush) }, [registerFlush, flush])

  function scheduleMsaAutosave(value: string) {
    if (msaSaveTimer.current) clearTimeout(msaSaveTimer.current)
    msaPendingValue.current = value
    setMsaSaveStatus('saving')
    msaSaveTimer.current = setTimeout(() => {
      msaSaveTimer.current = null
      void persistMsaRef(value)
    }, 800)
  }

  useEffect(() => {
    return () => { if (msaSaveTimer.current) clearTimeout(msaSaveTimer.current) }
  }, [])

  // FIX (re-audit, data-loss finding): warn before the tab closes/navigates
  // away while a section's edit hasn't been persisted yet — previously a
  // user could type, leave within the 1.5s debounce window, and lose the
  // edit with zero indication anything went wrong.
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (saveTimers.current.size > 0 || failedSaves.current.size > 0 || inFlight.current > 0 || msaSaveTimer.current) {
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
    setRegenLoading(sectionId); setRegenError(''); setRegenNotice('')
    try {
      const sec = sections.find(s => s.id === sectionId)
      const before = sec?.content || ''
      const res = await fetch('/api/sow/regenerate-section', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          sowId, sectionId,
          currentContent: before,
          instruction:    regenInstruction.trim() || null,
        }),
      })
      const json = await res.json().catch(() => ({} as any))
      if (!res.ok) throw new Error(json.error || 'The AI rewrite failed. Please try again.')
      if (json.truncated) {
        // The model's answer was cut off or ran past the length limit. The server kept the current
        // text; do not overwrite anything.
        setRegenNotice('The AI reply was too long or was cut off, so this section was left unchanged. Try a narrower instruction.')
        return
      }
      setSections(prev => prev.map(s => s.id === sectionId ? { ...s, content: json.content } : s))
      if (sectionId === activeSection) editor?.commands.setContent(json.content)
      scheduleAutosave(sectionId, { content: json.content })
      setRegenUndo({ sectionId, content: before })
      setShowRegen(null); setRegenInstruction('')
    } catch (err) {
      setRegenError(err instanceof Error ? err.message : 'The AI rewrite failed. Please try again.')
    } finally { setRegenLoading(null) }
  }

  function undoRegen() {
    if (!regenUndo) return
    const { sectionId, content } = regenUndo
    setSections(prev => prev.map(s => s.id === sectionId ? { ...s, content } : s))
    if (sectionId === activeSection) editor?.commands.setContent(content)
    scheduleAutosave(sectionId, { content })
    setRegenUndo(null)
  }

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
          {saveStatus === 'error'  && (
            <span title={saveError}>
              <i className="ti ti-alert-circle" style={{ fontSize: 11 }} /> Save failed{saveError ? ` — ${saveError}` : ''}{' '}
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => { void flush() }}>Retry</button>
            </span>
          )}
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 500 }}>
      {/* FIX (section-9 audit, 9-G4 — feature gap): metadata.msaReference
          write path. Shown above the section nav/editor split so it's
          visible regardless of which section is active — it's masthead
          metadata, not part of any one section's content. */}
      {(canEdit && !isLocked) ? (
        <div style={{
          padding: '8px 16px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
        }}>
          <label style={{ fontSize: 11, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
            MSA reference <span style={{ color: 'var(--text-4)' }}>— optional, printed on the PDF masthead</span>
          </label>
          <input
            className="finp"
            style={{ flex: 1, maxWidth: 340, fontSize: 12, padding: '4px 8px' }}
            value={msaRef}
            placeholder='e.g. "Per Master Services Agreement dated March 3, 2026"'
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              setMsaRef(e.target.value)
              scheduleMsaAutosave(e.target.value)
            }}
          />
          <span className={`save-status ${msaSaveStatus}`} style={{ fontSize: 11 }}>
            {msaSaveStatus === 'saving' && <span className="spin spin-dark" style={{ width: 10, height: 10 }} />}
            {msaSaveStatus === 'saved'  && <i className="ti ti-check" style={{ fontSize: 11, color: 'var(--green)' }} />}
            {msaSaveStatus === 'error'  && <i className="ti ti-alert-circle" style={{ fontSize: 11, color: 'var(--red)' }} />}
          </span>
        </div>
      ) : msaRef ? (
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--text-3)', flexShrink: 0 }}>
          MSA reference: {msaRef}
        </div>
      ) : null}
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
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

        {(regenError || regenNotice || (regenUndo && regenUndo.sectionId === current?.id)) && (
          <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', fontSize: 12, display: 'flex', gap: 10, alignItems: 'center',
            background: regenError ? 'var(--red-lt, #FEF2F2)' : 'var(--surface-2)', color: regenError ? 'var(--red)' : 'var(--text-2)' }}>
            <span style={{ flex: 1 }}>{regenError || regenNotice || 'Section rewritten with AI.'}</span>
            {!regenError && !regenNotice && regenUndo && regenUndo.sectionId === current?.id && (
              <button type="button" className="btn btn-ghost btn-xs" onClick={undoRegen}>Undo AI change</button>
            )}
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => { setRegenError(''); setRegenNotice(''); setRegenUndo(null) }}>Dismiss</button>
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
            {canViewFinancials && (
              <a href={`/api/pdf/sow/${sowId}`} target="_blank" className="btn btn-ghost btn-sm">
                <i className="ti ti-download" style={{ fontSize: 12 }} /> Preview PDF
              </a>
            )}
            {/* FIX (section-9 audit, 9-B14): there used to be a second
                "Send to client" button here behind an `onSend` prop the
                editor page never passed, so it never rendered — dead
                markup pretending to be an action. Send lives in the page's
                top bar, which is the only place it has ever worked from. */}
          </div>
        )}
      </div>
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
  // FIX (fix round, SOW-B3): this used to sum every row's amount regardless of sign
  // or milestone name, while lib/sow/validate-send.ts (the actual send-time check)
  // only counted named rows with a positive amount — so a schedule with a
  // legitimate negative "credit" row (or a stray amount on an unnamed row) could
  // show "Matches the contract value ✓" here and then fail at Send with a
  // different total, or vice versa. Now mirrors validate-send.ts exactly: every
  // named row's amount counts, whatever its sign, and an unnamed row never does.
  const showsTotals = sectionId === 'payment_schedule' && typeof contractValue === 'number'
  const scheduleTotal = showsTotals
    ? rows.reduce((sum, r) => String(r.milestone || '').trim() ? sum + (parseTableAmount(r.amount) ?? 0) : sum, 0)
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

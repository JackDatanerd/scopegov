// components/projects/ProjectDiscussion.tsx
//
// The Discussion tab — a general per-project message feed. Deliberately
// distinct from FlagCollaboration.tsx (governance notes on a single
// flag/exception): this is open collaboration for anyone on the project,
// supports @mentions, and lets a message be edited or removed.

'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { formatRelative } from '@/lib/utils/format'
import { splitBodySegments } from '@/lib/utils/project-messages'

interface Message {
  id: string
  body: string | null
  deleted: boolean
  createdAt: string
  editedAt: string | null
  authorId: string
  authorName: string
  authorAvatarUrl: string | null
  isMine: boolean
}

interface TeamMember {
  id: string
  name: string
  email: string
  avatarUrl: string | null
}

function initials(name: string): string {
  return name.split(' ').map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?'
}

function Avatar({ name, size = 26 }: { name: string; size?: number }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', background: 'var(--surface-2)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      fontSize: size * 0.42, fontWeight: 600, color: 'var(--text-2)',
    }}>
      {initials(name)}
    </div>
  )
}

// Renders a stored @[Name](id) body into text + mention chips.
function MessageBody({ body, currentUserId }: { body: string; currentUserId: string }) {
  const segments = splitBodySegments(body)
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === 'text'
          ? <span key={i}>{seg.value}</span>
          : (
            <span key={i} style={{
              fontWeight: 600,
              color: seg.userId === currentUserId ? 'var(--green)' : 'var(--text-1)',
              background: seg.userId === currentUserId ? 'var(--green-lt)' : 'var(--surface-2)',
              borderRadius: 4, padding: '0 4px',
            }}>
              @{seg.name}
            </span>
          )
      )}
    </>
  )
}

export default function ProjectDiscussion({
  projectId, team, currentUserId, canModerate, onRead,
}: {
  projectId: string
  team: TeamMember[]
  currentUserId: string
  // FIX (deep audit, section 7): the DELETE endpoint already allows an
  // admin (MANAGE_WORKSPACE_SETTINGS) to remove any message, not just
  // their own — this component had no way to know that and only ever
  // showed the delete action for the author. See app/(app)/projects/[id]/
  // page.tsx's `moderateMessages` permission.
  canModerate?: boolean
  onRead?: () => void
}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [loaded, setLoaded] = useState(false)
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [mentionOpts, setMentionOpts] = useState<TeamMember[]>([])
  const [mentionActive, setMentionActive] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const base = `/api/projects/${projectId}/messages`

  const load = useCallback(async () => {
    try {
      const res = await fetch(base)
      const json = await res.json()
      setMessages(json.messages || [])
      setLoaded(true)
    } catch { setError('Could not load the discussion.'); setLoaded(true) }
  }, [base])

  useEffect(() => { load() }, [load])

  // Mark read once the feed has loaded, and tell the parent tab badge
  // to clear — opening the tab is the read signal, same as most inbox UIs.
  useEffect(() => {
    if (!loaded) return
    fetch(`${base}/read`, { method: 'POST' }).catch(() => {})
    onRead?.()
  }, [loaded, base]) // eslint-disable-line

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages.length])

  function handleDraftChange(value: string) {
    setDraft(value)
    const caret = textareaRef.current?.selectionStart ?? value.length
    const upToCaret = value.slice(0, caret)
    const match = upToCaret.match(/@([^\s@]*)$/)
    if (match) {
      const q = match[1].toLowerCase()
      const opts = team.filter(m => m.id !== currentUserId && m.name.toLowerCase().includes(q)).slice(0, 6)
      setMentionOpts(opts)
      setMentionActive(opts.length > 0)
    } else {
      setMentionActive(false)
    }
  }

  function insertMention(member: TeamMember) {
    const caret = textareaRef.current?.selectionStart ?? draft.length
    const upToCaret = draft.slice(0, caret)
    const rest = draft.slice(caret)
    const replaced = upToCaret.replace(/@([^\s@]*)$/, `@[${member.name}](${member.id}) `)
    const next = replaced + rest
    setDraft(next)
    setMentionActive(false)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  async function submit() {
    const body = draft.trim()
    if (!body) return
    setPosting(true); setError('')
    try {
      const res = await fetch(base, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      })
      const json = await res.json()
      if (!res.ok) { setError(json.error || 'Could not send that message.'); return }
      setMessages(prev => [...prev, json.message])
      setDraft('')
    } finally { setPosting(false) }
  }

  function startEdit(m: Message) {
    setEditingId(m.id)
    setEditDraft(m.body || '')
  }

  async function saveEdit(id: string) {
    const body = editDraft.trim()
    if (!body) return
    try {
      const res = await fetch(`${base}/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      })
      const json = await res.json()
      if (!res.ok) { setError(json.error || 'Could not save that edit.'); return }
      setMessages(prev => prev.map(m => m.id === id ? { ...m, body, editedAt: json.message.editedAt } : m))
      setEditingId(null)
    } catch { setError('Could not save that edit.') }
  }

  async function removeMessage(id: string) {
    if (!confirm('Delete this message? This can\'t be undone.')) return
    try {
      const res = await fetch(`${base}/${id}`, { method: 'DELETE' })
      if (!res.ok) { const j = await res.json().catch(() => ({})); setError(j.error || 'Could not delete that message.'); return }
      setMessages(prev => prev.map(m => m.id === id ? { ...m, deleted: true, body: null } : m))
    } catch { setError('Could not delete that message.') }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 560, maxWidth: 720 }}>
      <div
        ref={listRef}
        style={{
          flex: 1, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
          padding: '14px 16px', background: 'var(--surface)', marginBottom: 10,
        }}
      >
        {!loaded ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-3)', textAlign: 'center', padding: '24px 0' }}>Loading…</div>
        ) : messages.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '32px 0' }}>
            <i className="ti ti-messages" style={{ fontSize: 22, color: 'var(--text-4)', display: 'block', margin: '0 auto 8px' }} />
            <p style={{ fontSize: 12.5, color: 'var(--text-3)', margin: 0 }}>
              No messages yet. Say hello, or @mention a teammate to loop them in.
            </p>
          </div>
        ) : (
          messages.map(m => (
            <div key={m.id} className="pm-row" style={{ display: 'flex', gap: 10, marginBottom: 14, position: 'relative' }}>
              <Avatar name={m.authorName} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <strong style={{ color: 'var(--text-1)' }}>{m.authorName}</strong>
                  <span style={{ color: 'var(--text-4)', fontSize: 11 }}>{formatRelative(m.createdAt)}</span>
                  {m.editedAt && !m.deleted && <span style={{ color: 'var(--text-4)', fontSize: 10.5 }}>(edited)</span>}
                </div>

                {m.deleted ? (
                  <div style={{ fontSize: 12.5, color: 'var(--text-4)', fontStyle: 'italic', marginTop: 3 }}>
                    Message deleted
                  </div>
                ) : editingId === m.id ? (
                  <div style={{ marginTop: 4 }}>
                    <textarea
                      className="finp" rows={2} value={editDraft} autoFocus
                      onChange={e => setEditDraft(e.target.value)}
                      style={{ fontSize: 12.5, resize: 'vertical' }}
                    />
                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      <button className="btn btn-ghost btn-xs" onClick={() => saveEdit(m.id)}>Save</button>
                      <button className="btn btn-ghost btn-xs" onClick={() => setEditingId(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5, marginTop: 3, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    <MessageBody body={m.body || ''} currentUserId={currentUserId} />
                  </div>
                )}
              </div>

              {!m.deleted && (m.isMine || canModerate) && editingId !== m.id && (
                <div className="pm-actions" style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  {m.isMine && (
                    <button className="btn-icon" title="Edit" onClick={() => startEdit(m)}
                      style={{ width: 22, height: 22, border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-3)' }}>
                      <i className="ti ti-pencil" style={{ fontSize: 12 }} />
                    </button>
                  )}
                  <button className="btn-icon" title={m.isMine ? 'Delete' : 'Remove message (admin)'} onClick={() => removeMessage(m.id)}
                    style={{ width: 22, height: 22, border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-3)' }}>
                    <i className="ti ti-trash" style={{ fontSize: 12 }} />
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {error && <p style={{ fontSize: 11.5, color: 'var(--red)', marginBottom: 8 }}>{error}</p>}

      <div style={{ position: 'relative' }}>
        {mentionActive && (
          <div style={{
            position: 'absolute', bottom: '100%', left: 0, marginBottom: 6, width: 240, zIndex: 20,
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.16)', overflow: 'hidden',
          }}>
            {mentionOpts.map(m => (
              <button
                key={m.id}
                onClick={() => insertMention(m)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                  padding: '7px 10px', background: 'none', border: 'none', cursor: 'pointer',
                  borderBottom: '1px solid var(--surface-2)',
                }}
              >
                <Avatar name={m.name} size={20} />
                <span style={{ fontSize: 12.5, color: 'var(--text-1)' }}>{m.name}</span>
              </button>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            ref={textareaRef}
            className="finp"
            rows={2}
            placeholder="Message the project team… use @ to mention someone"
            value={draft}
            onChange={e => handleDraftChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !mentionActive) {
                e.preventDefault()
                if (!posting) submit()
              }
              if (e.key === 'Escape') setMentionActive(false)
            }}
            style={{ flex: 1, fontSize: 13, resize: 'vertical' }}
          />
          <button className="btn btn-primary btn-sm" disabled={posting || !draft.trim()} onClick={submit}>
            {posting ? <span className="spin" style={{ width: 12, height: 12 }} /> : <><i className="ti ti-send" style={{ fontSize: 12 }} /> Send</>}
          </button>
        </div>
      </div>
    </div>
  )
}

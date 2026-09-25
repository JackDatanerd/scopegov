// components/projects/ProjectDiscussion.tsx
//
// The Discussion tab — a general per-project message feed. Deliberately
// distinct from FlagCollaboration.tsx (governance notes on a single
// flag/exception): this is open collaboration for anyone on the project,
// supports @mentions, and lets a message be edited or removed.

'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { formatRelative } from '@/lib/utils/format'
import { splitBodySegments, tokensToDisplay, displayToTokens } from '@/lib/utils/project-messages'

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

function Avatar({ name, avatarUrl, size = 26 }: { name: string; avatarUrl?: string | null; size?: number }) {
  // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — feature
  // gap): both call sites already had a real avatarUrl in hand
  // (authorAvatarUrl / TeamMember.avatarUrl, both correctly sourced
  // server-side in app/api/projects/[id]/messages/route.ts) but never
  // passed it in — this component only ever rendered initials. See
  // api/workspace/profile/avatar/route.ts for where that value now
  // actually comes from.
  if (avatarUrl) {
    return (
      <img src={avatarUrl} alt="" width={size} height={size}
        style={{ borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
    )
  }
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
  // Projects & Dashboard deep audit: the feed used to load the oldest 200
  // messages only. It now loads the newest page, can page backwards, and
  // polls for new messages so the discussion doesn't go stale until a reload.
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const preserveScrollRef = useRef(false)
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [mentionOpts, setMentionOpts] = useState<TeamMember[]>([])
  const [mentionActive, setMentionActive] = useState(false)
  const [mentionIndex, setMentionIndex] = useState(0)
  // Who can be @-mentioned: the project's team PLUS everyone who can see every project (owners/admins who
  // aren't assigned to it). Loaded from the same list the server validates mentions against; the `team`
  // prop (assigned members only) is the fallback if that request fails.
  const [people, setPeople] = useState<TeamMember[]>(team)
  // The composer shows "@Alice Smith", not the raw @[Alice Smith](uuid) token. `picked` remembers which
  // user each picked name refers to; it is turned back into tokens on send (displayToTokens).
  const pickedRef = useRef<Record<string, string>>({})
  const editPickedRef = useRef<Record<string, string>>({})
  // Server clock at the last successful sync — passed back as changedSince so edits/deletes made by
  // OTHER people show up without a reload.
  const syncedAtRef = useRef<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const base = `/api/projects/${projectId}/messages`

  const load = useCallback(async () => {
    try {
      const res = await fetch(base)
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Could not load the discussion.')
      setMessages(json.messages || [])
      setHasMore(!!json.hasMore)
      syncedAtRef.current = json.syncedAt || null
      setLoaded(true)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load the discussion.'); setLoaded(true) }
  }, [base])

  async function loadOlder() {
    const oldest = messages[0]
    if (!oldest || loadingOlder) return
    setLoadingOlder(true)
    try {
      const res = await fetch(`${base}?before=${encodeURIComponent(oldest.createdAt)}`)
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Could not load earlier messages.')
      preserveScrollRef.current = true
      setMessages(prev => {
        const have = new Set(prev.map(m => m.id))
        return [...(json.messages || []).filter((m: Message) => !have.has(m.id)), ...prev]
      })
      setHasMore(!!json.hasMore)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load earlier messages.')
    } finally { setLoadingOlder(false) }
  }

  useEffect(() => { load() }, [load])

  useEffect(() => {
    let cancelled = false
    fetch(`${base}/mentionable`).then(r => r.ok ? r.json() : null).then(json => {
      if (cancelled || !json?.members) return
      setPeople(json.members.map((m: any) => ({ id: m.id, name: m.name, email: '', avatarUrl: m.avatarUrl || null })))
    }).catch(() => { /* keep the team fallback */ })
    return () => { cancelled = true }
  }, [base])

  // Mark read once the feed has loaded, and tell the parent tab badge
  // to clear — opening the tab is the read signal, same as most inbox UIs.
  // Mark read up to the newest message actually on screen (not "now"), so a
  // message that arrives between the fetch and this call is not silently
  // marked as read.
  const newestCreatedAt = messages.length ? messages[messages.length - 1].createdAt : null
  useEffect(() => {
    if (!loaded) return
    fetch(`${base}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newestCreatedAt ? { upTo: newestCreatedAt } : {}),
    }).catch(() => {})
    onRead?.()
  }, [loaded, base, newestCreatedAt]) // eslint-disable-line

  // Poll for new messages while the tab is visible.
  const newestRef = useRef<string | null>(null)
  newestRef.current = newestCreatedAt
  useEffect(() => {
    if (!loaded) return
    const timer = setInterval(async () => {
      if (document.visibilityState !== 'visible') return
      try {
        if (!newestRef.current) { await load(); return }
        const qs = new URLSearchParams({ after: newestRef.current })
        if (syncedAtRef.current) qs.set('changedSince', syncedAtRef.current)
        const res = await fetch(`${base}?${qs.toString()}`)
        if (!res.ok) return
        const json = await res.json()
        if (json.syncedAt) syncedAtRef.current = json.syncedAt
        const incoming: Message[] = json.messages || []
        const changed: Message[] = json.changed || []
        if (!incoming.length && !changed.length) return
        setMessages(prev => {
          const have = new Set(prev.map(m => m.id))
          const fresh = incoming.filter(m => !have.has(m.id))
          const byId = new Map(changed.map(c => [c.id, c]))
          const merged = byId.size
            ? prev.map(m => { const c = byId.get(m.id); return c ? { ...m, body: c.body, deleted: c.deleted, editedAt: c.editedAt } : m })
            : prev
          return fresh.length ? [...merged, ...fresh] : merged
        })
      } catch { /* transient — next tick retries */ }
    }, 30000)
    return () => clearInterval(timer)
  }, [loaded, base, load])

  useEffect(() => {
    if (preserveScrollRef.current) { preserveScrollRef.current = false; return }
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages.length])

  function handleDraftChange(value: string) {
    setDraft(value)
    const caret = textareaRef.current?.selectionStart ?? value.length
    const upToCaret = value.slice(0, caret)
    const match = upToCaret.match(/@([^\s@]*)$/)
    if (match) {
      const q = match[1].toLowerCase()
      const opts = people.filter(m => m.id !== currentUserId && m.name.toLowerCase().includes(q)).slice(0, 6)
      setMentionOpts(opts)
      setMentionIndex(0)
      setMentionActive(opts.length > 0)
    } else {
      setMentionActive(false)
    }
  }

  function insertMention(member: TeamMember) {
    const caret = textareaRef.current?.selectionStart ?? draft.length
    const upToCaret = draft.slice(0, caret)
    const rest = draft.slice(caret)
    pickedRef.current[member.name] = member.id
    const replaced = upToCaret.replace(/@([^\s@]*)$/, `@${member.name} `)
    const next = replaced + rest
    setDraft(next)
    setMentionActive(false)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  async function submit() {
    const body = displayToTokens(draft.trim(), pickedRef.current)
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
      pickedRef.current = {}
    } finally { setPosting(false) }
  }

  function startEdit(m: Message) {
    const { text, picked } = tokensToDisplay(m.body || '')
    editPickedRef.current = picked
    setEditingId(m.id)
    setEditDraft(text)
  }

  async function saveEdit(id: string) {
    const body = displayToTokens(editDraft.trim(), editPickedRef.current)
    if (!body) return
    try {
      const res = await fetch(`${base}/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      })
      const json = await res.json()
      if (!res.ok) { setError(json.error || 'Could not save that edit.'); return }
      setMessages(prev => prev.map(m => m.id === id ? { ...m, body: json.message.body ?? body, editedAt: json.message.editedAt } : m))
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
          <>
            {hasMore && (
              <div style={{ textAlign: 'center', marginBottom: 10 }}>
                <button className="btn btn-ghost btn-xs" onClick={loadOlder} disabled={loadingOlder}>
                  {loadingOlder ? 'Loading…' : 'Load earlier messages'}
                </button>
              </div>
            )}
            {messages.map(m => (
            <div key={m.id} className="pm-row" style={{ display: 'flex', gap: 10, marginBottom: 14, position: 'relative' }}>
              <Avatar name={m.authorName} avatarUrl={m.authorAvatarUrl} />
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
            ))}
          </>
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
            {mentionOpts.map((m, i) => (
              <button
                key={m.id}
                onMouseDown={e => e.preventDefault()}
                onClick={() => insertMention(m)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                  padding: '7px 10px', background: i === mentionIndex ? 'var(--surface-2)' : 'none', border: 'none', cursor: 'pointer',
                  borderBottom: '1px solid var(--surface-2)',
                }}
              >
                <Avatar name={m.name} avatarUrl={m.avatarUrl} size={20} />
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
              if (mentionActive) {
                // Enter/Tab picks the highlighted person (Enter used to do nothing while the picker was
                // open, so the keyboard could never complete a mention); arrows move the highlight.
                if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex(i => (i + 1) % mentionOpts.length); return }
                if (e.key === 'ArrowUp')   { e.preventDefault(); setMentionIndex(i => (i - 1 + mentionOpts.length) % mentionOpts.length); return }
                if ((e.key === 'Enter' || e.key === 'Tab') && mentionOpts[mentionIndex]) {
                  e.preventDefault(); insertMention(mentionOpts[mentionIndex]); return
                }
              }
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

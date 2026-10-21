'use client'
// components/ui/Dialogs.tsx
//
// One modal system for the whole app.
//
//   <Modal>            the shell every dialog uses: backdrop, centred panel, header / body / footer, Esc to close, focus kept inside and
//                      returned on close, proper dialog semantics for screen readers.
//   useDialogs()       promise-based replacements for window.confirm / alert / prompt, rendered with <Modal>:
//                        if (!(await dialogs.confirm('Delete this draft? This cannot be undone.'))) return
//                        await dialogs.alert('Reminder sent.')
//                        const note = await dialogs.prompt({ title: 'Reply to the client', multiline: true })
//
// A plain string keeps working (it is split into a title and an explanation, and the button names the action), and an options object
// gives full control. <DialogProvider> sits in the root layout so every page, including onboarding, admin and the portal, has it.

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  ALERT_TITLES, alertTone, confirmLabel as inferConfirmLabel, confirmTone, splitMessage,
  type AlertTone, type ConfirmTone,
} from '@/lib/ui/dialog-text'

// ── The shell ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface ModalProps {
  title: React.ReactNode
  subtitle?: React.ReactNode
  /** Small icon-and-colour badge shown beside the title (dialogs use it for the tone). */
  icon?: { name: string; tone: 'default' | 'danger' | 'warning' | 'success' | 'info' }
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** Buttons, right-aligned under a divider. Use <ModalFooter> or your own. */
  footer?: React.ReactNode
  /** Esc, the backdrop and the close button call this. Omit to make the dialog impossible to dismiss without choosing. */
  onClose?: () => void
  /** While true (a save in flight) the dialog cannot be dismissed. */
  busy?: boolean
  /** Element to focus first; defaults to the first field, else the first button. */
  initialFocusRef?: React.RefObject<HTMLElement | null>
  role?: 'dialog' | 'alertdialog'
  /** Above other modals (a confirmation opened from inside another dialog). */
  layer?: 'base' | 'top'
  children?: React.ReactNode
}

export function Modal({ title, subtitle, icon, size = 'md', footer, onClose, busy, initialFocusRef, role = 'dialog', layer = 'base', children }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descId = useId()
  const canClose = !!onClose && !busy

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    const target = initialFocusRef?.current
      ?? panel?.querySelector<HTMLElement>('input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled])')
      ?? panel?.querySelector<HTMLElement>('[data-autofocus], button.btn-primary, button')
    target?.focus()
    return () => { if (opener && document.contains(opener)) opener.focus() }
  }, [initialFocusRef])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && canClose) { e.stopPropagation(); onClose!() }
    if (e.key !== 'Tab') return
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(el => el.offsetParent !== null)
    if (!items.length) return
    const first = items[0]; const last = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  return (
    <div className={`dlg-layer${layer === 'top' ? ' dlg-top' : ''}`} onKeyDown={onKeyDown}>
      <div className="dlg-backdrop" onMouseDown={canClose ? onClose : undefined} aria-hidden="true" />
      <div ref={panelRef} className={`dlg dlg-${size}`} role={role} aria-modal="true" aria-labelledby={titleId} aria-describedby={descId}>
        <div className="dlg-head">
          {icon && <span className={`dlg-icon dlg-icon-${icon.tone}`} aria-hidden="true"><i className={`ti ti-${icon.name}`} /></span>}
          <div className="dlg-head-text">
            <h2 className="dlg-title" id={titleId}>{title}</h2>
            {subtitle && <p className="dlg-sub">{subtitle}</p>}
          </div>
          {canClose && (
            <button type="button" className="dlg-x" onClick={onClose} aria-label="Close"><i className="ti ti-x" /></button>
          )}
        </div>
        <div className="dlg-body" id={descId}>{children}</div>
        {footer && <div className="dlg-foot">{footer}</div>}
      </div>
    </div>
  )
}

/** Cancel + primary button, the footer most modals want. */
export function ModalFooter({ onCancel, onConfirm, cancelLabel = 'Cancel', confirmLabel = 'Save', busy, disabled, tone = 'default' }: {
  onCancel?: () => void; onConfirm?: () => void; cancelLabel?: string; confirmLabel?: React.ReactNode; busy?: boolean; disabled?: boolean; tone?: ConfirmTone
}) {
  return (
    <>
      {onCancel && <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>{cancelLabel}</button>}
      {onConfirm && (
        <button type="button" className={`btn btn-sm ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm} disabled={busy || disabled}>
          {busy ? <span className="spin" /> : confirmLabel}
        </button>
      )}
    </>
  )
}

// ── Promise-based dialogs ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface ConfirmOptions {
  title?: string
  message?: React.ReactNode | string
  /** A list of points shown under the message (for example the warnings found before a send). */
  items?: string[]
  confirmLabel?: string
  cancelLabel?: string
  tone?: ConfirmTone
}
export interface AlertOptions {
  title?: string
  message?: React.ReactNode | string
  tone?: AlertTone
  okLabel?: string
  /** A link or code shown in a read-only field with a Copy button (replaces window.prompt used to show something to copy). */
  copyValue?: string
}
export interface PromptOptions {
  title: string
  message?: string
  label?: string
  defaultValue?: string
  placeholder?: string
  multiline?: boolean
  inputType?: 'text' | 'date' | 'email' | 'number'
  confirmLabel?: string
  /** When false (default for multiline) an empty answer is accepted and returned as ''. Cancel always returns null. */
  required?: boolean
  /** Return an error message to keep the dialog open, or null when the value is fine. */
  validate?: (value: string) => string | null
}

interface Dialogs {
  confirm: (opts: string | ConfirmOptions) => Promise<boolean>
  alert: (opts: string | AlertOptions) => Promise<void>
  prompt: (opts: PromptOptions) => Promise<string | null>
}

type Pending =
  | { id: number; kind: 'confirm'; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { id: number; kind: 'alert'; opts: AlertOptions; resolve: () => void }
  | { id: number; kind: 'prompt'; opts: PromptOptions; resolve: (v: string | null) => void }

const DialogContext = createContext<Dialogs | null>(null)

/** Used outside a provider (a unit-rendered component, a story) the browser dialogs are the fallback, so nothing silently stops working. */
const nativeFallback: Dialogs = {
  confirm: async o => (typeof window === 'undefined' ? false : window.confirm(typeof o === 'string' ? o : `${o.title ?? ''}\n\n${typeof o.message === 'string' ? o.message : ''}`.trim())),
  alert: async o => { if (typeof window !== 'undefined') window.alert(typeof o === 'string' ? o : `${o.title ?? ''}\n\n${typeof o.message === 'string' ? o.message : ''}`.trim()) },
  prompt: async o => (typeof window === 'undefined' ? null : window.prompt(o.title, o.defaultValue ?? '')),
}

export function useDialogs(): Dialogs {
  return useContext(DialogContext) ?? nativeFallback
}

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([])
  const nextId = useRef(1)

  const enqueue = useCallback(<T,>(make: (id: number, resolve: (v: T) => void) => Pending) =>
    new Promise<T>(resolve => setQueue(q => [...q, make(nextId.current++, resolve)])), [])

  const dialogs = useMemo<Dialogs>(() => ({
    confirm: opts => enqueue<boolean>((id, resolve) => ({ id, kind: 'confirm', opts: typeof opts === 'string' ? { message: opts } : opts, resolve })),
    alert: opts => enqueue<void>((id, resolve) => ({ id, kind: 'alert', opts: typeof opts === 'string' ? { message: opts } : opts, resolve: () => resolve() })),
    prompt: opts => enqueue<string | null>((id, resolve) => ({ id, kind: 'prompt', opts, resolve })),
  }), [enqueue])

  const current = queue[0]
  const settle = (fn: () => void) => { fn(); setQueue(q => q.slice(1)) }

  return (
    <DialogContext.Provider value={dialogs}>
      {children}
      {current?.kind === 'confirm' && <ConfirmDialog key={current.id} opts={current.opts} onResult={v => settle(() => current.resolve(v))} />}
      {current?.kind === 'alert' && <AlertDialog key={current.id} opts={current.opts} onDone={() => settle(() => current.resolve())} />}
      {current?.kind === 'prompt' && <PromptDialog key={current.id} opts={current.opts} onResult={v => settle(() => current.resolve(v))} />}
    </DialogContext.Provider>
  )
}

const TONE_ICON: Record<string, { name: string; tone: 'default' | 'danger' | 'warning' | 'success' | 'info' }> = {
  danger: { name: 'alert-triangle', tone: 'danger' },
  warning: { name: 'alert-circle', tone: 'warning' },
  default: { name: 'help-circle', tone: 'info' },
  error: { name: 'alert-octagon', tone: 'danger' },
  success: { name: 'circle-check', tone: 'success' },
  info: { name: 'info-circle', tone: 'info' },
}

function Body({ paragraphs, message, items }: { paragraphs?: string[]; message?: React.ReactNode; items?: string[] }) {
  return (
    <>
      {paragraphs?.map((p, i) => <p key={i} className="dlg-p">{p}</p>)}
      {message && typeof message !== 'string' && <div className="dlg-p">{message}</div>}
      {items && items.length > 0 && <ul className="dlg-list">{items.map((it, i) => <li key={i}>{it}</li>)}</ul>}
    </>
  )
}

function ConfirmDialog({ opts, onResult }: { opts: ConfirmOptions; onResult: (v: boolean) => void }) {
  const text = typeof opts.message === 'string' ? opts.message : ''
  const tone: ConfirmTone = opts.tone ?? confirmTone(text || opts.title || '')
  const parts = opts.title ? { title: opts.title, paragraphs: text ? text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean) : [] } : splitMessage(text, 'Please confirm')
  const cancelRef = useRef<HTMLButtonElement>(null)
  // A destructive confirmation opens with Cancel focused, so an accidental Enter never destroys anything.
  return (
    <Modal
      layer="top" role="alertdialog" size="sm" onClose={() => onResult(false)}
      title={parts.title} icon={TONE_ICON[tone]} initialFocusRef={tone === 'danger' ? cancelRef : undefined}
      footer={<>
        <button ref={cancelRef} type="button" className="btn btn-ghost btn-sm" onClick={() => onResult(false)}>{opts.cancelLabel ?? 'Cancel'}</button>
        <button type="button" data-autofocus className={`btn btn-sm ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`} onClick={() => onResult(true)}>
          {opts.confirmLabel ?? inferConfirmLabel(text || opts.title || '')}
        </button>
      </>}
    >
      <Body paragraphs={parts.paragraphs} message={opts.message} items={opts.items} />
    </Modal>
  )
}

function AlertDialog({ opts, onDone }: { opts: AlertOptions; onDone: () => void }) {
  const text = typeof opts.message === 'string' ? opts.message : ''
  const tone: AlertTone = opts.tone ?? alertTone(text || opts.title || '')
  const parts = opts.title ? { title: opts.title, paragraphs: text ? text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean) : [] } : splitMessage(text, ALERT_TITLES[tone])
  const [copied, setCopied] = useState(false)
  const fieldRef = useRef<HTMLInputElement>(null)
  const copy = async () => {
    try { await navigator.clipboard.writeText(opts.copyValue ?? ''); setCopied(true) } catch { fieldRef.current?.select() }
  }
  return (
    <Modal layer="top" role="alertdialog" size="sm" onClose={onDone} title={parts.title} icon={TONE_ICON[tone]}
      footer={<button type="button" data-autofocus className="btn btn-primary btn-sm" onClick={onDone}>{opts.okLabel ?? 'OK'}</button>}>
      <Body paragraphs={parts.paragraphs} message={opts.message} />
      {opts.copyValue && (
        <div className="dlg-copy">
          <input ref={fieldRef} className="finp" readOnly value={opts.copyValue} onFocus={e => e.currentTarget.select()} aria-label="Link" />
          <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      )}
    </Modal>
  )
}

function PromptDialog({ opts, onResult }: { opts: PromptOptions; onResult: (v: string | null) => void }) {
  const [value, setValue] = useState(opts.defaultValue ?? '')
  const [error, setError] = useState<string | null>(null)
  const required = opts.required ?? !opts.multiline
  const submit = () => {
    const v = value.trim()
    if (required && !v) { setError('Enter a value to continue.'); return }
    const problem = opts.validate ? opts.validate(v) : null
    if (problem) { setError(problem); return }
    onResult(v)
  }
  const common = {
    className: 'finp', value, placeholder: opts.placeholder, 'aria-label': opts.label ?? opts.title,
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => { setValue(e.target.value); setError(null) },
  }
  return (
    <Modal layer="top" size="sm" onClose={() => onResult(null)} title={opts.title} subtitle={opts.message}
      footer={<>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onResult(null)}>Cancel</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={submit}>{opts.confirmLabel ?? 'Continue'}</button>
      </>}>
      {opts.label && <label className="flbl">{opts.label}</label>}
      {opts.multiline
        ? <textarea {...common} rows={4} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit() }} />
        : <input {...common} type={opts.inputType ?? 'text'} onKeyDown={e => { if (e.key === 'Enter') submit() }} />}
      {error && <p className="dlg-error" role="alert">{error}</p>}
    </Modal>
  )
}

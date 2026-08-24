// components/ui/RichTextField.tsx
//
// FIX (doc-quality audit round 3): CO `note` and Invoice
// `paymentInstructions` were plain <textarea> fields — sanitizePlainText
// on write, no formatting possible. That was a deliberate prior decision
// (see lib/utils/sanitize.ts's comment on sanitizePlainText), not a bug,
// but it means a payment-terms paragraph with a bolded due date, or a
// change-order reason with a short bullet list, simply can't be
// expressed. This extracts the same Tiptap setup SowEditor already uses
// (Bold/Italic/bullet list/numbered list) into a small reusable field so
// any short client-facing text block in the app can opt into the same
// capability without re-deriving the toolbar each time.
//
// Controlled component: `value` is a sanitized HTML string (or empty),
// `onChange` fires with the new HTML on every edit. The caller is
// responsible for sanitizing again server-side on write — this is a
// UI-layer convenience, not a trust boundary (see sanitizeRichText).

'use client'
import { useEffect } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'

interface Props {
  value:       string
  onChange:    (html: string) => void
  placeholder?: string
  disabled?:   boolean
  minHeight?:  number
}

export default function RichTextField({ value, onChange, placeholder, disabled, minHeight = 80 }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: placeholder || 'Start writing…' }),
    ],
    content: value,
    editable: !disabled,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    editorProps: {
      attributes: { class: 'editor-body' },
    },
  }, [])

  // Keeps the editor in sync with external value changes — e.g. an
  // "AI draft" flow calling setNote(...)/setPaymentInstructions(...)
  // from outside this component, or the form loading a different
  // record. Guarded by the equality check so this never fires on the
  // editor's own keystrokes (onUpdate already pushed that same value up
  // to the parent, so value === editor.getHTML() and nothing happens —
  // without the guard this would fight the user's cursor on every
  // keystroke).
  useEffect(() => {
    if (!editor) return
    if (value !== editor.getHTML()) editor.commands.setContent(value || '', false)
  }, [value, editor])

  if (!editor) return null

  const toolbarBtn = (label: string, active: boolean, onClick: () => void, style?: React.CSSProperties) => (
    <button type="button" key={label}
      className={active ? 'is-active' : ''}
      onClick={onClick}
      disabled={disabled}
      style={style}>
      {label}
    </button>
  )

  return (
    <div className="finp" style={{ padding: 0, minHeight: minHeight + 34, opacity: disabled ? 0.6 : 1 }}>
      {!disabled && (
        <div className="editor-toolbar">
          {toolbarBtn('B', editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), { fontWeight: 700 })}
          {toolbarBtn('I', editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run(), { fontStyle: 'italic' })}
          {toolbarBtn('≡', editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run())}
          {toolbarBtn('1.', editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run())}
        </div>
      )}
      <EditorContent editor={editor} style={{ minHeight }} />
    </div>
  )
}

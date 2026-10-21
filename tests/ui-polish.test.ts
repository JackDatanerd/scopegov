import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')
function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(join(root, dir))) {
    const rel = join(dir, f)
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out)
    else if (/\.tsx?$/.test(f)) out.push(rel)
  }
  return out
}

describe('no native browser dialogs ("scopegov.app says")', () => {
  const files = [...walk('app'), ...walk('components')].filter(f => !f.endsWith('components/ui/Dialogs.tsx'))
  it('no component calls window.alert / confirm / prompt', () => {
    const offenders = files.filter(f => /(^|[^.\w])(window\.)?(alert|confirm|prompt)\(/m.test(
      read(f).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')))
    expect(offenders).toEqual([])
  })
  it('every file that uses dialogs gets them from the hook, and the provider is mounted at the root', () => {
    for (const f of files) {
      const src = read(f)
      if (/await dialogs\./.test(src)) {
        expect(src, f).toMatch(/import \{ useDialogs[^}]*\} from '@\/components\/ui\/Dialogs'/)
        expect(src, f).toContain('const dialogs = useDialogs()')
      }
    }
    expect(read('app/layout.tsx')).toContain('<DialogProvider>{children}</DialogProvider>')
  })
  it('the native fallback exists only for a missing provider', () => {
    const d = read('components/ui/Dialogs.tsx')
    expect(d).toContain('useContext(DialogContext) ?? nativeFallback')
  })
  it('a destructive confirm focuses Cancel, not the destructive button', () => {
    expect(read('components/ui/Dialogs.tsx')).toContain("initialFocusRef={tone === 'danger' ? cancelRef : undefined}")
  })
})

describe('every class a modal uses has CSS', () => {
  const css = read('styles/globals.css')
  it('the names six modals were written with are defined', () => {
    for (const sel of ['.form-label', '.form-input', '.modal-overlay']) expect(css, sel).toContain(sel)
  })
  it('dialog styles exist', () => {
    for (const sel of ['.dlg-layer', '.dlg-backdrop', '.dlg-head', '.dlg-body', '.dlg-foot', '.dlg-icon-danger']) expect(css, sel).toContain(sel)
  })
})

describe('modals share one look', () => {
  it('the five ProjectDetail modals that used undefined classes now use the shared shell', () => {
    const pd = read('components/projects/ProjectDetail.tsx')
    expect(pd).not.toContain('modal-overlay')
    expect(pd).not.toContain('className="form-label"')
    expect(pd).toContain('<ModalFooter onCancel={onClose} onConfirm={submit}')
    expect(read('components/projects/EditProjectModal.tsx')).toContain('<Modal')
  })
  it('older modals get the same panel, motion and phone layout, and Esc closes them', () => {
    const css = read('styles/globals.css')
    expect(css).toContain('@keyframes modal-pop')
    expect(css).toContain('border-radius: 10px; box-shadow: 0 18px 50px')
    expect(read('components/layout/AppShell.tsx')).toContain("document.querySelector<HTMLElement>('.modal-bg')")
  })
})

describe('pages stay centred when the sidebar is hidden', () => {
  const css = read('styles/globals.css')
  it('.page centres its max-width column instead of hugging the left edge', () => {
    expect(css).toMatch(/\.page \{[^}]*max-width: 1080px; margin-left: auto; margin-right: auto;/)
  })
  it('the project header band and its tab content share one centred column so they line up', () => {
    expect(css).toContain('.page-col { width: 100%; max-width: 1080px; margin: 0 auto;')
    const pd = read('components/projects/ProjectDetail.tsx')
    expect(pd).toContain('<div className="page-col">')
    expect(pd).toContain('<div className="page-col" style={{ paddingTop: 24, paddingBottom: 24 }}>')
    expect(pd).toContain("<div className=\"tabbar\" style={{ borderBottom: 'none' }}>")
    expect(read('components/co/CoEditor.tsx')).toContain("maxWidth: 960, margin: '0 auto'")
  })
})

describe('page width experiment (centred / full)', () => {
  const shell = read('components/layout/AppShell.tsx')
  const css = read('styles/globals.css')
  it('is remembered per browser, defaults to centred, and tolerates blocked storage', () => {
    expect(shell).toContain("const WIDTH_KEY = 'sg.width'")
    expect(shell).toContain("window.localStorage.getItem(WIDTH_KEY) === 'full'")
    expect(shell).toContain("data-width={fullWidth ? 'full' : 'centered'}")
  })
  it('full width overrides the inline max-widths on every page wrapper', () => {
    expect(css).toMatch(/\.app\[data-width="full"\] \.page,\s*\.app\[data-width="full"\] \.page-col,\s*\.app\[data-width="full"\] \.co-grid \{ max-width: none !important; \}/)
    expect(read('components/co/CoEditor.tsx')).toContain('className="co-grid"')
  })
  it('the switch is in the sidebar header and in the reopen bar, so it is reachable either way', () => {
    expect(read('components/layout/Sidebar.tsx')).toContain('<PageWidthButton />')
    expect(shell).toMatch(/<span style=\{\{ flex: 1 \}\} \/>\s*<PageWidthButton \/>/)
  })
})

describe('peek at the navigation while the sidebar is collapsed', () => {
  const shell = read('components/layout/AppShell.tsx')
  const css = read('styles/globals.css')
  it('hovering the reopen button or the left edge opens it, with hover-intent delays so a passing mouse does not flash it', () => {
    expect(shell).toContain('setTimeout(() => setPeek(true), 120)')
    expect(shell).toContain('setTimeout(() => setPeek(false), 280)')
    expect(shell).toContain('<div className="sb-edge"')
    expect(shell).toContain('{...peekHandlers} aria-label="Show sidebar"')
  })
  it('it is the real sidebar floated over the page (same links, badges and active state), only on hover devices', () => {
    expect(css).toContain('@media (hover: hover) and (min-width: 769px)')
    expect(css).toContain('.app[data-sidebar="collapsed"][data-peek="open"] .sb {')
    expect(read('components/layout/Sidebar.tsx')).toContain('<aside className="sb" {...peekHandlers}>')
  })
  it('following a link, Esc or expanding closes it, and the pin button keeps it open', () => {
    expect(shell).toContain('setPeek(false) // following a link from the floating navigation closes it')
    expect(shell).toContain('else if (peekOpenRef.current) setPeek(false)')
    expect(shell).toContain('aria-label="Keep sidebar open"')
  })
  it('a collapsed sidebar is only reachable by keyboard while it is peeking', () => {
    expect(shell).toContain("toggleAttribute('inert', collapsed && !peek)")
  })
})

describe('collapsible sidebar', () => {
  const shell = read('components/layout/AppShell.tsx')
  it('is wired into the signed-in layout with a way back when collapsed', () => {
    const layout = read('app/(app)/layout.tsx')
    expect(layout).toContain('<AppShell>')
    expect(layout).toContain('<SidebarReopenBar />')
    expect(read('components/layout/Sidebar.tsx')).toContain('<SidebarCollapseButton />')
  })
  it('remembers the choice, tolerates blocked storage, and keeps a collapsed sidebar out of the tab order', () => {
    expect(shell).toContain("const STORAGE_KEY = 'sg.sidebar'")
    expect(shell).toMatch(/catch \{ return null \}/)
    expect(shell).toContain("toggleAttribute('inert', collapsed && !peek)")
  })
  it('has a keyboard shortcut and starts closed on a phone', () => {
    expect(shell).toContain("e.key === '\\\\'")
    expect(shell).toContain("(max-width: 768px)")
  })
  it('collapsed state hides the sidebar and sticky panels clear the reopen bar', () => {
    const css = read('styles/globals.css')
    expect(css).toContain('.app[data-sidebar="collapsed"] .sb { margin-left: -240px; visibility: hidden;')
    expect(css).toContain('--sticky-top: 52px')
    expect(read('components/co/CoEditor.tsx')).toContain("top: 'var(--sticky-top, 20px)'")
  })
})

describe('warnings read cleanly', () => {
  it('the date-conflict message never ends a quoted sentence with ."', () => {
    expect(read('lib/sow/date-conflicts.ts')).toContain("sent.trim().replace(/[.\\s]+$/, '')")
  })
})

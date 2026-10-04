import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { truncateText } from '@/lib/utils/sanitize'
import { announceNotificationsChanged, NOTIFICATIONS_CHANGED_EVENT } from '@/lib/utils/notification-links'

// Notifications & email independent pass 8.
//  1. Notification bodies (and the client-text notes in the matching emails) were cut with a raw .slice(0, N), which can
//     strand half an emoji. Postgres cannot store a lone surrogate, so the whole notifications insert failed — and every
//     notify helper only logs and returns false, so the bell row silently never existed.
//  2. The sidebar bell and the /notifications inbox kept separate unread counts; actions in the inbox left the bell badge
//     stale for up to a minute.

const root = path.resolve(__dirname, '..')
const read = (p: string) => readFileSync(path.join(root, p), 'utf8')

const SITES = [
  'app/api/portal/invoice/[token]/dispute/route.ts',
  'app/api/portal/invoice/[token]/paid/route.ts',
  'app/api/portal/sow/[token]/request-changes/route.ts',
  'app/api/portal/sow/[token]/decline/route.ts',
  'app/api/portal/co/[token]/_actions.ts',
  'lib/utils/project-messages.ts',
]

describe('surrogate-safe truncation of notification text', () => {
  it('truncateText never leaves half an emoji at the cut', () => {
    const s = 'a'.repeat(159) + '😀' + 'tail'
    const cut = truncateText(s, 160)
    expect(cut.length).toBe(159)
    expect(/[\uD800-\uDBFF]$/.test(cut)).toBe(false)
    // a raw slice is what used to run
    expect(/[\uD800-\uDBFF]$/.test(s.slice(0, 160))).toBe(true)
  })

  it('every notification / receipt site uses truncateText instead of a raw text slice', () => {
    for (const f of SITES) {
      const src = read(f)
      expect(src, f).toContain('truncateText')
      // no `.slice(0, N)` applied to the client/teammate free text any more
      expect(src, f).not.toMatch(/(reason|note|counterNote|plain)\.slice\(0,/)
      expect(src, f).not.toMatch(/`\.slice\(0, \d+\)/)
    }
  })
})

describe('inbox → bell sync', () => {
  const g = globalThis as any
  const original = g.window
  afterEach(() => { if (original === undefined) delete g.window; else g.window = original })

  it('announceNotificationsChanged dispatches the event the bell listens for', () => {
    const seen: string[] = []
    g.window = { dispatchEvent: (e: Event) => { seen.push(e.type); return true } }
    announceNotificationsChanged()
    expect(seen).toEqual([NOTIFICATIONS_CHANGED_EVENT])
  })

  it('is a no-op on the server (no window)', () => {
    delete g.window
    expect(() => announceNotificationsChanged()).not.toThrow()
  })

  it('the inbox announces after successful writes and the bell subscribes', () => {
    const inbox = read('components/notifications/NotificationsClient.tsx')
    expect(inbox.match(/announceNotificationsChanged\(\)/g)?.length).toBeGreaterThanOrEqual(2)
    const bell = read('components/layout/NotificationBell.tsx')
    expect(bell).toContain('NOTIFICATIONS_CHANGED_EVENT')
    expect(bell).toContain("removeEventListener(NOTIFICATIONS_CHANGED_EVENT")
  })
})

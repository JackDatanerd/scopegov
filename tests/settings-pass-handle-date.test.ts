import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatDateInZone } from '@/lib/utils/timezone'

// Settings pass (B5): the handle-cooldown hint must state the date in the workspace's saved zone,
// exactly like the API's 409 message, not in the browser's locale/zone.
describe('workspace handle cooldown date', () => {
  it('renders one instant as different calendar days in different zones (why the zone must be explicit)', () => {
    const at = new Date('2026-10-30T22:30:00Z')
    expect(formatDateInZone(at, 'UTC')).toBe('30 Oct 2026')
    expect(formatDateInZone(at, 'Africa/Nairobi')).toBe('31 Oct 2026')
  })
  it('falls back to UTC for an empty or unusable saved zone', () => {
    const at = new Date('2026-10-30T22:30:00Z')
    expect(formatDateInZone(at, null)).toBe('30 Oct 2026')
    expect(formatDateInZone(at, '')).toBe('30 Oct 2026')
  })
  it('SettingsClient no longer uses the browser-locale formatter for the hint', () => {
    const src = readFileSync(join(process.cwd(), 'components/settings/SettingsClient.tsx'), 'utf8')
    expect(src).not.toContain('nextSlugChangeAt!.toLocaleDateString()')
    expect(src).toContain('formatDateInZone(nextSlugChangeAt!, savedTimezone)')
    expect(src).toContain('savedTimezone={workspace?.timezone || null}')
  })
})

import { describe, it, expect } from 'vitest'
import { parseTableSections } from '@/lib/ai/sow-content'

describe('B1 — AI table rows', () => {
  const raw = `<<<TABLE:deliverables>>>
| Deliverable | Acceptance Criteria | Owner | Target Date |
|---|---|---|---|
| Logo | Approved | Provider | Week 2 |
Brand book | Signed off | Client | Week 4
<<<ENDTABLE>>>
<<<TABLE:timeline>>>
Phase | Description | Duration
Discovery | Research | 2 weeks
<<<ENDTABLE>>>
<<<TABLE:roles>>>
Responsibility | Provider | Client | Notes
Design | ✓ | — |
<<<ENDTABLE>>>`
  const t = parseTableSections(raw)
  it('drops header echo and separator, strips outer pipes', () => {
    expect(t.deliverables.map(r => r.deliverable)).toEqual(['Logo', 'Brand book'])
    expect(t.deliverables[0]).toMatchObject({ acceptanceCriteria: 'Approved', owner: 'Provider', targetDate: 'Week 2' })
    expect(t.timeline).toHaveLength(1)
    expect(t.roles.map(r => r.responsibility)).toEqual(['Design'])
  })
})

import { describe, it, expect, afterEach } from 'vitest'
import { aiModel, structuredJobParams, scaleMaxTokens, DEFAULT_AI_MODEL } from '@/lib/ai/model'

const saved = process.env.ANTHROPIC_MODEL
afterEach(() => { if (saved === undefined) delete process.env.ANTHROPIC_MODEL; else process.env.ANTHROPIC_MODEL = saved })

describe('ai model selection', () => {
  it('defaults to Sonnet 5.5, ANTHROPIC_MODEL overrides, blank falls back', () => {
    delete process.env.ANTHROPIC_MODEL
    expect(aiModel()).toBe('claude-sonnet-5-5')
    expect(DEFAULT_AI_MODEL).toBe('claude-sonnet-5-5')
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6'
    expect(aiModel()).toBe('claude-sonnet-4-6')
    process.env.ANTHROPIC_MODEL = '  '
    expect(aiModel()).toBe('claude-sonnet-5-5')
  })
  it('Sonnet 5.5: lowest thinking, never "disabled", never temperature', () => {
    const p = structuredJobParams('claude-sonnet-5-5', { temperature: 0 })
    expect(p).toEqual({ thinking: { type: 'between_tools' } })
  })
  it('older models keep temperature and get no thinking field', () => {
    expect(structuredJobParams('claude-haiku-4-5-20251001', { temperature: 0 })).toEqual({ temperature: 0 })
    expect(structuredJobParams('claude-sonnet-4-6')).toEqual({})
  })
  it('Sonnet 5 (not 5.5) drops sampling but gets no between_tools', () => {
    expect(structuredJobParams('claude-sonnet-5', { temperature: 0 })).toEqual({})
  })
  it('scales output budgets only for 5.x tokenizers', () => {
    expect(scaleMaxTokens('claude-sonnet-5-5', 400)).toBe(600)
    expect(scaleMaxTokens('claude-haiku-4-5-20251001', 400)).toBe(400)
  })
})

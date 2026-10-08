import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createWithTool, isForcedToolChoiceRejection, __resetRejectingModelsForTests } from '@/lib/ai/tool-call'

const rejection = () => Object.assign(new Error('400 {...}'), {
  status: 400,
  error: { type: 'error', error: { type: 'invalid_request_error', message: 'tool_choice: type "tool" and "any" are not supported for this model.' } },
})
const params = { model: 'm1', max_tokens: 10, tools: [{ name: 't', input_schema: { type: 'object' as const } }], messages: [{ role: 'user' as const, content: 'hi' }] }

beforeEach(() => { __resetRejectingModelsForTests(); vi.spyOn(console, 'warn').mockImplementation(() => {}) })

describe('createWithTool', () => {
  it('forces the tool when the model allows it', async () => {
    const create = vi.fn().mockResolvedValue({ content: [] })
    await createWithTool({ messages: { create } } as any, params, 't')
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0].tool_choice).toEqual({ type: 'tool', name: 't' })
  })
  it('retries once with auto + an instruction when the model rejects a forced tool_choice, then skips the forced call', async () => {
    const create = vi.fn().mockRejectedValueOnce(rejection()).mockResolvedValue({ content: [] })
    await createWithTool({ messages: { create } } as any, params, 't')
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[1][0].tool_choice).toEqual({ type: 'auto' })
    expect(create.mock.calls[1][0].messages[0].content).toContain('`t` tool')
    expect(params.messages[0].content).toBe('hi') // caller's messages untouched
    await createWithTool({ messages: { create } } as any, params, 't')
    expect(create).toHaveBeenCalledTimes(3)
    expect(create.mock.calls[2][0].tool_choice).toEqual({ type: 'auto' })
  })
  it('does not swallow other errors', async () => {
    const create = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }))
    await expect(createWithTool({ messages: { create } } as any, params, 't')).rejects.toThrow('boom')
    expect(create).toHaveBeenCalledTimes(1)
    expect(isForcedToolChoiceRejection(Object.assign(new Error('x'), { status: 400, message: 'max_tokens too large' }))).toBe(false)
  })
})

// lib/ai/tool-call.ts
//
// "Draft with AI" (change order, invoice) asks the model for structured output by FORCING a tool call
// (tool_choice: { type: 'tool', name }). Some models reject that outright with a 400:
//   tool_choice: type "tool" and "any" are not supported for this model.
// The env-configurable ANTHROPIC_MODEL made that a deployment-time failure: pointing it at such a model turned
// every CO draft into a 500. This helper keeps the forced call where it works and, on that specific rejection,
// retries once with tool_choice 'auto' plus an explicit instruction to call the tool. The model that rejected
// a forced call is remembered for the life of the instance so later requests skip the wasted round trip.

import type Anthropic from '@anthropic-ai/sdk'

type CreateParams = Anthropic.MessageCreateParamsNonStreaming

const rejectingModels = new Set<string>()

/** True for Anthropic's 400 "tool_choice ... not supported for this model" (and nothing else). */
export function isForcedToolChoiceRejection(err: unknown): boolean {
  const e = err as any
  if (!e || e.status !== 400) return false
  const msg = String(e?.error?.error?.message ?? e?.error?.message ?? e?.message ?? '')
  return /tool_choice/i.test(msg) && /not supported/i.test(msg)
}

function withToolInstruction(messages: CreateParams['messages'], toolName: string): CreateParams['messages'] {
  const note = `\n\nRespond by calling the \`${toolName}\` tool with your answer. Do not reply with plain text.`
  const out = messages.map(m => ({ ...m }))
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role !== 'user') continue
    const c = out[i].content
    out[i].content = typeof c === 'string' ? c + note : [...c, { type: 'text' as const, text: note.trim() }]
    break
  }
  return out
}

export async function createWithTool(
  client: Pick<Anthropic, 'messages'>,
  params: Omit<CreateParams, 'tool_choice' | 'stream'>,
  toolName: string,
): Promise<Anthropic.Message> {
  const auto = () => client.messages.create({
    ...params, messages: withToolInstruction(params.messages, toolName), tool_choice: { type: 'auto' },
  })
  if (rejectingModels.has(params.model)) return auto()
  try {
    return await client.messages.create({ ...params, tool_choice: { type: 'tool', name: toolName } })
  } catch (err) {
    if (!isForcedToolChoiceRejection(err)) throw err
    rejectingModels.add(params.model)
    console.warn(`[ai] ${params.model} rejects a forced tool_choice; using tool_choice auto`)
    return auto()
  }
}

/** Test seam. */
export function __resetRejectingModelsForTests() { rejectingModels.clear() }

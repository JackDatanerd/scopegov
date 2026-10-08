// lib/ai/model.ts
//
// One place that decides which model every AI feature (SOW generate / regenerate / brief parsing, change-order and
// invoice drafting, Guardian classification) calls, and the request settings that model needs.
//
// Default: Claude Sonnet 5.5. Override with ANTHROPIC_MODEL (e.g. to roll back to claude-sonnet-4-6).
//
// What Claude Sonnet 5.5 changes versus the Haiku 4.5 / Sonnet 4.x requests this app used to send
// (platform docs, "Migrating to Claude Sonnet 5.5"):
//   • tool_choice type 'tool' / 'any' is a 400            → lib/ai/tool-call.ts retries with 'auto'
//   • non-default temperature / top_p / top_k is a 400    → never sent to a 5.x model
//   • adaptive thinking is ON by default, and max_tokens covers thinking + text, so a small budget (Guardian's 400)
//     can be eaten by thinking and leave no answer. thinking: { type: 'disabled' } is itself a 400 on 5.5; the
//     lowest setting is { type: 'between_tools' } — no up-front thinking, which is what these short structured
//     jobs want (and keeps latency/cost down)
//   • the tokenizer produces ~30% more tokens for the same text → output budgets are scaled up

export const DEFAULT_AI_MODEL = 'claude-sonnet-5-5'

export function aiModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_AI_MODEL
}

/** Claude 5.x models (Sonnet 5 / 5.5, Opus 5 / 5.5, ...) reject non-default sampling parameters. */
export function rejectsSamplingParams(model: string): boolean {
  return /^claude-(sonnet|opus|fable|mythos)-5/.test(model)
}

/** Sonnet 5.5 turns adaptive thinking on by default and rejects thinking: { type: 'disabled' }. */
export function isSonnet55(model: string): boolean {
  return /^claude-sonnet-5-5/.test(model)
}

/**
 * Extra request fields for a short, structured job (classify / extract / draft): no up-front thinking where the model
 * would otherwise think by default, and `temperature` only on models that still accept it.
 */
export function structuredJobParams(model: string, opts: { temperature?: number } = {}): any {
  const out: Record<string, unknown> = {}
  if (isSonnet55(model)) out.thinking = { type: 'between_tools' }
  if (opts.temperature !== undefined && !rejectsSamplingParams(model)) out.temperature = opts.temperature
  return out
}

/** Output budget for `base` tokens as measured on the old tokenizer; 5.x models count ~30% more for the same text. */
export function scaleMaxTokens(model: string, base: number): number {
  return rejectsSamplingParams(model) ? Math.ceil(base * 1.5) : base
}

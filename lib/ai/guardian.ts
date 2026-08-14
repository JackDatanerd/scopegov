export const runtime = 'nodejs'

import Anthropic from '@anthropic-ai/sdk'
import { stripAndParse, stripHtml } from '@/lib/utils/format'
import OpenAI from 'openai'

// FIX (re-audit — build-blocking): both clients were constructed at module
// scope, so an unset ANTHROPIC_API_KEY/OPENAI_API_KEY turned into a hard
// build failure at "Collecting page data" for any route importing this
// file, rather than a runtime error scoped to guardian classification.
// Lazy singletons, matching the fix already applied in lib/email/templates.ts.
let _anthropic: Anthropic | null = null
function anthropicClient(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _anthropic
}
let _openai: OpenAI | null = null
function openaiClient(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return _openai
}

export type Sensitivity = 'conservative' | 'medium' | 'aggressive'

const THRESHOLDS: Record<Sensitivity, { autoFlag: number; borderlineMin: number }> = {
  conservative: { autoFlag: 0.92, borderlineMin: 0.75 },
  medium:       { autoFlag: 0.85, borderlineMin: 0.60 },
  aggressive:   { autoFlag: 0.78, borderlineMin: 0.55 },
}

export interface ClassificationResult {
  outcome:          'in_scope' | 'borderline' | 'out_of_scope' | 'covered_by_co'
  matchConfidence:  number
  creepConfidence:  number
  matchedAgainst:   'sow' | 'amendment' | null
  matchedReference: string | null
  reasoning:        string
}

interface ScopeSnapshot {
  deliverables: Array<{ title: string; description?: string }>
  outOfScope:   Array<{ title: string; description?: string }>
}

interface Amendment {
  id: string
  added_deliverables: string[]
  title: string
}

export async function classifyGuardianCheck({
  content,
  snapshot,
  amendments = [],
  sensitivity = 'medium',
}: {
  content:     string
  snapshot:    ScopeSnapshot
  amendments?: Amendment[]
  sensitivity?: Sensitivity
}): Promise<ClassificationResult> {
  const { autoFlag, borderlineMin } = THRESHOLDS[sensitivity]

  const deliverablesText = snapshot.deliverables
    .map(d => `- ${d.title}${d.description ? `: ${d.description}` : ''}`)
    .join('\n') || '(none defined)'

  const oosText = snapshot.outOfScope
    .map(d => `- ${d.title}${d.description ? `: ${d.description}` : ''}`)
    .join('\n') || '(none defined)'

  const amendmentsText = amendments.length
    ? amendments.flatMap(a => a.added_deliverables.map(d => `- ${d} (CO: ${a.title})`)).join('\n')
    : '(none)'

  const prompt = `You are a scope governance AI for an agency. Analyse the submitted content against the signed project scope.

SIGNED SCOPE — In scope deliverables:
${deliverablesText}

SIGNED SCOPE — Explicitly excluded (out of scope):
${oosText}

ACCEPTED CHANGE ORDERS (covered by CO):
${amendmentsText}

SUBMITTED CONTENT:
"""
${stripHtml(content).slice(0, 2000)}
"""

Return ONLY valid JSON, no markdown fences:
{
  "matchConfidence": 0.0,
  "matchedAgainst": "sow" | "amendment" | null,
  "matchedReference": "exact deliverable name or null",
  "creepConfidence": 0.0,
  "reasoning": "One sentence explanation"
}

Rules:
- matchConfidence: 0–1 probability this request is covered by an existing signed deliverable or accepted CO. 1.0 = exact match.
- creepConfidence: 0–1 probability this is scope creep / out-of-scope request. 1.0 = definitely out of scope.
  Items matching an EXPLICITLY EXCLUDED (out of scope) clause should receive creepConfidence >= 0.90.
- matchedAgainst: "amendment" if matched a CO deliverable, "sow" if matched original scope, null if no match.
- matchedReference: the specific deliverable name matched, or null.
- reasoning: factual, one sentence. Do not interpret intent. Describe what matched or didn't match.
- When in doubt, lean BORDERLINE rather than OUT_OF_SCOPE to minimise false positives.`

  const msg = await anthropicClient().messages.create({
    model:       'claude-haiku-4-5-20251001', // Haiku acceptable for classification (carry-forward §1.5)
    max_tokens:  400,
    temperature: 0,                            // Classification prompt contract §1.6.2
    messages:    [{ role: 'user', content: prompt }],
  })

  const raw    = msg.content.filter(b => b.type === 'text').map((b: any) => b.text).join('')
  const parsed = stripAndParse<{
    matchConfidence: number; matchedAgainst: string | null
    matchedReference: string | null; creepConfidence: number; reasoning: string
  }>(raw)

  const matchConf  = Math.max(0, Math.min(1, parsed.matchConfidence || 0))
  const creepConf  = Math.max(0, Math.min(1, parsed.creepConfidence || 0))

  // Classification decision flow per spec §1.6.1
  let outcome: ClassificationResult['outcome']
  if (matchConf >= 0.85 && parsed.matchedAgainst === 'amendment') {
    outcome = 'covered_by_co'
  } else if (matchConf >= 0.85) {
    outcome = 'in_scope'
  } else if (creepConf >= autoFlag) {
    outcome = 'out_of_scope'
  } else if (creepConf >= borderlineMin) {
    outcome = 'borderline'
  } else {
    outcome = 'in_scope'
  }

  return {
    outcome,
    matchConfidence:  matchConf,
    creepConfidence:  creepConf,
    matchedAgainst:   (parsed.matchedAgainst as 'sow' | 'amendment' | null) || null,
    matchedReference: parsed.matchedReference || null,
    reasoning:        parsed.reasoning || '',
  }
}

// ── Embedding for dedup ───────────────────────────────────────
// BUG-060: embedding ALWAYS computed; only PERSISTED for non-duplicates
export async function getEmbedding(text: string): Promise<number[]> {
  const res = await openaiClient().embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 2000), // first 2000 chars for dedup (spec §1.6.4)
  })
  return res.data[0].embedding
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

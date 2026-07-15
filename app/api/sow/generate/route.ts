export const runtime = 'nodejs'
// FIX: no explicit maxDuration was set, so this route ran under Vercel's
// platform default (as low as 10s on some plans) — generating a full SOW
// can legitimately take longer than that, especially now that max_tokens
// is higher. This is a defensive complement to the max_tokens fix above,
// not a replacement for it: truncated JSON was the confirmed symptom
// (stripAndParse failing on a *received* response), but a real infra
// timeout was also possible and worth ruling out explicitly.
export const maxDuration = 60

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { stripAndParse } from '@/lib/utils/format'
import { logAudit } from '@/lib/utils/audit'
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL  = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001'

const PAYMENT_STRUCTURE_LABELS: Record<string, string> = {
  '50_50':       '50% due upfront, 50% due upon final delivery',
  '100_upfront': '100% due before work commences',
  'milestones':  'Payable in milestones as defined below',
  'monthly':     'Billed monthly in advance',
  'on_delivery': '100% due upon final delivery and approval',
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'EDIT_SOW'))
      return NextResponse.json({ error: 'Missing permission: EDIT_SOW' }, { status: 403 })

    const {
      projectId, projectType, objective, deliverables,
      outOfScope, timeline, paymentStructure, revisionRounds,
      contractValue, currency,
    } = await request.json()

    if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 })

    const service = createServiceClient()

    // Fetch project + client + workspace for context
    const { data: project } = await (service as any)
      .from('projects')
      .select('id,name,disc,currency,clients(name,email,company_name),workspaces(agency_name,governing_law,sow_language)')
      .eq('id', projectId).eq('workspace_id', session.workspaceId).single()
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const agencyName    = project.workspaces?.agency_name || session.agencyName
    const clientName    = project.clients?.company_name || project.clients?.name || 'Client'
    const governingLaw  = project.workspaces?.governing_law || 'Republic of Kenya'
    const paymentLabel  = PAYMENT_STRUCTURE_LABELS[paymentStructure] || paymentStructure
    const curr          = currency || project.currency || 'USD'

    // ── AI Generation prompt ──────────────────────────────────
    const prompt = `You are a professional contract drafter for a creative/digital agency.
Generate a complete Statement of Work as strict JSON. Use ONLY the exact figures provided. Never invent payment amounts, fees, or rates.

Agency: ${agencyName}
Client: ${clientName}
Project: ${project.name}${project.disc ? ` (${project.disc})` : ''}
Project type: ${projectType}
Contract value: ${curr} ${contractValue}

Scope brief:
Objective: ${objective || 'Not specified'}
Deliverables:
${deliverables || 'As discussed'}

Out of scope (MUST be explicitly excluded):
${outOfScope || 'To be defined'}

Timeline: ${timeline || 'To be agreed'}
Payment structure: ${paymentLabel}
Revision rounds: ${revisionRounds || 2}
Governing law: ${governingLaw}

Return ONLY this JSON — no markdown, no preamble, no explanation:
{
  "sections": [
    {
      "id": "parties",
      "title": "Parties",
      "content": "<p>This Statement of Work is entered into between <strong>${agencyName}</strong> (\"Agency\") and <strong>${clientName}</strong> (\"Client\").</p>",
      "visible": true,
      "order": 1
    },
    {
      "id": "overview",
      "title": "Project Overview",
      "content": "...",
      "visible": true,
      "order": 2
    },
    {
      "id": "deliverables",
      "title": "Deliverables",
      "content": "...",
      "visible": true,
      "order": 3
    },
    {
      "id": "oos",
      "title": "Out of Scope",
      "content": "...",
      "visible": true,
      "order": 4
    },
    {
      "id": "assumptions",
      "title": "Assumptions & Dependencies",
      "content": "...",
      "visible": true,
      "order": 5
    },
    {
      "id": "timeline",
      "title": "Timeline & Milestones",
      "content": "...",
      "visible": true,
      "order": 6
    },
    {
      "id": "payment",
      "title": "Payment Terms",
      "content": "...",
      "visible": true,
      "order": 7
    },
    {
      "id": "revisions",
      "title": "Revision Policy",
      "content": "...",
      "visible": true,
      "order": 8
    },
    {
      "id": "ip",
      "title": "Intellectual Property",
      "content": "...",
      "visible": true,
      "order": 9
    },
    {
      "id": "confidentiality",
      "title": "Confidentiality",
      "content": "...",
      "visible": true,
      "order": 10
    },
    {
      "id": "termination",
      "title": "Termination",
      "content": "...",
      "visible": true,
      "order": 11
    },
    {
      "id": "governing_law",
      "title": "Governing Law",
      "content": "<p>This Agreement is governed by the laws of ${governingLaw}.</p>",
      "visible": true,
      "order": 12
    },
    {
      "id": "dispute",
      "title": "Dispute Resolution",
      "content": "...",
      "visible": true,
      "order": 13
    },
    {
      "id": "signature",
      "title": "Signatures",
      "content": "<p>By signing below, both parties agree to the terms of this Statement of Work.</p>",
      "visible": true,
      "order": 14
    }
  ],
  "metadata": {
    "paymentStructure": "${paymentStructure}",
    "revisionRounds": ${revisionRounds || 2},
    "governingLaw": "${governingLaw}"
  }
}

Rules:
- All content must be proper HTML (use <p>, <ul>, <li>, <strong>). No raw text outside tags.
- Payment section must state exactly "${curr} ${contractValue}" and the exact payment structure above. Do NOT invent percentages or amounts beyond what's stated.
- Out of scope section must list every item from the out-of-scope brief as explicit exclusions. Be specific.
- Revision policy must reference exactly ${revisionRounds || 2} revision round(s).
- Write with professional, authoritative language appropriate for a legal document.
- Never add a "late fee rate" or "revision fee" unless explicitly provided.`

    let raw = ''
    let stopReason: string | null = null
    try {
      const msg = await client.messages.create({
        model:      MODEL,
        // FIX: 4000 was genuinely tight for a full 14-section legal
        // document with "professional, authoritative language" — easily
        // enough to truncate mid-generation, producing incomplete (and
        // therefore unparseable) JSON. This is very likely the actual
        // cause of "AI returned invalid JSON" rather than a Vercel
        // infra-level timeout, since that error only fires *after* a
        // response was successfully received and parsed.
        max_tokens: 8000,
        messages:   [{ role: 'user', content: prompt }],
      })
      raw = msg.content.filter(b => b.type === 'text').map((b: any) => b.text).join('')
      stopReason = msg.stop_reason
    } catch (aiErr) {
      console.error('AI SOW generation failed:', aiErr)
      return NextResponse.json({ error: 'AI generation failed. Please try again.' }, { status: 503 })
    }

    // BUG-027: stripAndParse on every AI response
    let parsed: { sections: any[]; metadata: any }
    try {
      parsed = stripAndParse(raw)
    } catch {
      console.error('JSON parse failed, stop_reason:', stopReason, 'raw output:', raw.slice(0, 500))
      const truncated = stopReason === 'max_tokens'
      return NextResponse.json({
        error: truncated
          ? 'The generated SOW was too long and got cut off. Try shortening the brief or simplifying the deliverables list, then retry.'
          : 'AI returned invalid JSON. Please try again.',
      }, { status: 500 })
    }

    // Check for existing draft SOW on this project
    const { data: existingSow } = await (service as any)
      .from('sow_documents')
      .select('id,version')
      .eq('project_id', projectId)
      .eq('status', 'draft')
      .order('version', { ascending: false })
      .limit(1)
      .single()

    let sowId: string

    if (existingSow) {
      // Update existing draft
      await (service as any).from('sow_documents')
        .update({ sections: parsed.sections, metadata: parsed.metadata, updated_at: new Date().toISOString() })
        .eq('id', existingSow.id)
      sowId = existingSow.id
    } else {
      // Get latest version number
      const { data: latestSow } = await (service as any)
        .from('sow_documents')
        .select('version')
        .eq('project_id', projectId)
        .order('version', { ascending: false })
        .limit(1)
        .single()
      const nextVersion = (latestSow?.version || 0) + 1

      const { data: newSow, error: sowErr } = await (service as any)
        .from('sow_documents')
        .insert({
          project_id:   projectId,
          workspace_id: session.workspaceId,
          version:      nextVersion,
          status:       'draft',
          sections:     parsed.sections,
          metadata:     parsed.metadata,
        })
        .select('id').single()
      if (sowErr) throw new Error(sowErr.message)
      sowId = newSow.id
    }

    // Update project status to Intake if still Draft
    await (service as any).from('projects')
      .update({ status: 'Intake', updated_at: new Date().toISOString() })
      .eq('id', projectId).eq('status', 'Draft')

    await logAudit(service, {
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name,
      eventType: 'sow.drafted', entityType: 'sow',
      entityId: sowId, entityName: project.name,
      metadata: { project_type: projectType },
    })

    return NextResponse.json({ sowId })
  } catch (err) {
    console.error('SOW generate error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal error' }, { status: 500 })
  }
}

// lib/documents/co-impact.ts
//
// Loads what a change order's money rows and payment statement are built from, once for every surface (staff PDF, portal PDF,
// portal page). The numbers and wording themselves live in co-impact-view.ts, which has no server imports.

import { getContractValueBefore, retainerMonthlyNetForOneTimeCo, retainerMonthlyGrossFor } from '@/lib/documents/co-contract-value'
import { effectivePaymentTermsDays } from '@/lib/documents/payment-terms'
import { normalizeLateFeeRate } from '@/lib/documents/late-fee'

export * from '@/lib/documents/co-impact-view'

/** What the CO's money rows and its payment statement are built from, loaded once for every surface. */
export async function loadCoImpactContext(service: any, args: {
  coId: string; projectId: string; project: any; isRenewal: boolean; isCredit: boolean; workspaceDefaultTermsDays?: unknown
}) {
  const { data: sow } = await (service as any)
    .from('sow_documents').select('document_number, version, metadata')
    .eq('project_id', args.projectId).eq('status', 'signed').order('version', { ascending: false }).limit(1).maybeSingle()
  const contractValueBefore = await getContractValueBefore(
    service, args.projectId, args.coId, args.project?.contract_value ?? null, { isRenewal: args.isRenewal, project: args.project },
  )
  const retainerMonthlyNet = await retainerMonthlyNetForOneTimeCo(service, args.projectId, args.project, { isRenewal: args.isRenewal, isCredit: args.isCredit })
  return {
    sow,
    contractValueBefore,
    retainerMonthlyNet,
    retainerMonthlyGross: retainerMonthlyGrossFor(args.project, retainerMonthlyNet),
    paymentTermsDays: effectivePaymentTermsDays(sow?.metadata, args.workspaceDefaultTermsDays),
    lateFeeRate: normalizeLateFeeRate(sow?.metadata?.lateFeeRate),
  }
}


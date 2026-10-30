import PlanCalculator from '@/components/calculator/PlanCalculator'
import { parseCalculatorParams } from '@/lib/billing/roi-url'

export const metadata = {
  alternates: { canonical: '/calculator' },
  title: 'What is scope creep costing you? · ScopeGov',
  description: 'Estimate what scope creep costs your agency each year and which ScopeGov plan fits. Every number is yours to edit.',
}

// Public version of the calculator (no workspace data, signup CTA). It opens blank, or prefilled from the query string
// when the homepage calculator hands its numbers over (lib/billing/roi-url.ts — every value is clamped on the way in).
export default async function PublicCalculatorPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const defaults = parseCalculatorParams((await searchParams) ?? {})
  return <PlanCalculator mode="public" measured={null} defaults={defaults} />
}

import PlanCalculator from '@/components/calculator/PlanCalculator'

export const metadata = {
  title: 'What is scope creep costing you? · ScopeGov',
  description: 'Estimate what scope creep costs your agency each year and which ScopeGov plan fits. Every number is yours to edit.',
}

// Public, blank version of the calculator (no workspace data, signup CTA).
export default function PublicCalculatorPage() {
  return <PlanCalculator mode="public" measured={null} defaults={{}} />
}

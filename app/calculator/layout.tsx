import CalculatorShell from '@/components/calculator/CalculatorShell'

export default function CalculatorLayout({ children }: { children: React.ReactNode }) {
  return <CalculatorShell>{children}</CalculatorShell>
}

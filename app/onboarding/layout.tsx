import StepUpHost from '@/components/auth/StepUpHost'

// FIX (fresh independent audit, section 4): StepUpHost — the "Confirm it's you" modal that
// fetchWithStepUp() (lib/client/step-up.ts) opens when a route answers 401 step_up_required —
// was only ever mounted in app/(app)/layout.tsx, and /onboarding deliberately sits outside
// that layout (it can't require a completed workspace). The wizard's "Discard this workspace"
// calls DELETE /api/workspace/delete, which is step-up guarded, so once the session's sign-in
// was more than 10 minutes old it failed with "Please confirm it's you to continue" and no way
// to do so. Mounting the host here gives every step-up-guarded call the wizard makes a modal.
export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <StepUpHost />
    </>
  )
}

'use client'

// lib/client/step-up.ts
//
// fetch() wrapper for the routes guarded by lib/auth/step-up.ts. When such a route
// answers 401 { code: 'step_up_required' }, ask the person to confirm (a
// password or authenticator code, via the <StepUpHost /> modal mounted in the app
// layout) and retry the ORIGINAL request once. Anything else — including the
// person cancelling — comes back as the plain response, so existing call sites keep
// their own error handling.

export type StepUpMethod = 'password' | 'totp'

export const STEP_UP_EVENT = 'sg:step-up'
export const STEP_UP_HOST_FLAG = '__sgStepUpHost'

export interface StepUpRequestDetail {
  methods: StepUpMethod[]
  resolve: (confirmed: boolean) => void
}

function requestStepUp(methods: StepUpMethod[]): Promise<boolean> {
  return new Promise(resolve => {
    if (typeof window === 'undefined' || !(window as any)[STEP_UP_HOST_FLAG]) return resolve(false)
    window.dispatchEvent(new CustomEvent<StepUpRequestDetail>(STEP_UP_EVENT, { detail: { methods, resolve } }))
  })
}

export async function fetchWithStepUp(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init)
  if (res.status !== 401) return res
  const body = await res.clone().json().catch(() => null) as { code?: string; methods?: StepUpMethod[] } | null
  if (body?.code !== 'step_up_required' || !body.methods?.length) return res
  const confirmed = await requestStepUp(body.methods)
  if (!confirmed) return res
  return fetch(input, init)
}

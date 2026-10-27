// lib/billing/paystack-public-key.ts
//
// The Paystack PUBLIC key (pk_...) is handed to the browser by api/billing/upgrade in the checkout JSON, so it is
// only ever read on the server — it does not need the NEXT_PUBLIC_ prefix (that prefix only matters for values the
// client bundle reads directly, and Vercel warns about any NEXT_PUBLIC_ name containing "KEY").
//
// Preferred name: PAYSTACK_PUBLIC_KEY. The older names stay as fallbacks so an existing deployment keeps working
// whichever one it was configured with (NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY was the original; NEXT_CONFIG_PAYSTACK_PUBLIC_KEY
// is what an operator renamed it to after the Vercel warning). First one that is set wins.
export const PAYSTACK_PUBLIC_KEY_ENV_NAMES = [
  'PAYSTACK_PUBLIC_KEY',
  'NEXT_CONFIG_PAYSTACK_PUBLIC_KEY',
  'NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY',
] as const

type Env = Record<string, string | undefined>

export function getPaystackPublicKey(env: Env = process.env): string | null {
  for (const name of PAYSTACK_PUBLIC_KEY_ENV_NAMES) {
    const v = env[name]?.trim()
    if (v) return v
  }
  return null
}

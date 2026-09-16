// lib/constants/workspace-options.ts
//
// FIX (Workspace lifecycle + Onboarding, round 4): app/onboarding/page.tsx
// defined its own INDUSTRIES/CURRENCIES/TIMEZONES arrays inline, and
// api/workspace/create + api/workspace/settings only ever truthy-checked
// industry and defaulted currency/timezone — neither validated against
// this list, and there was no DB CHECK constraint backing any of the
// three either. Free-text industry/currency/timezone isn't dangerous by
// itself, but there's no reason to accept values the UI never offers
// (typo'd currency codes, an invalid IANA zone), and this is the same
// "validate against the curated set the app actually supports" pattern
// already used for sow_language in workspace/settings. Single source of
// truth so the client dropdown and server validation can't drift apart.

export const INDUSTRIES = [
  'Creative & Design', 'Web & App Development', 'Marketing & Advertising',
  'Branding & Identity', 'Video & Animation', 'Architecture & Interior',
  'Consulting & Strategy', 'Photography', 'PR & Communications', 'Other',
] as const

export const CURRENCIES = ['USD', 'KES', 'GBP', 'EUR', 'ZAR', 'NGN', 'GHS', 'AED', 'CAD', 'AUD'] as const

export const TIMEZONES = [
  'Africa/Nairobi', 'Africa/Lagos', 'Africa/Accra', 'Africa/Johannesburg', 'Africa/Cairo',
  'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles',
  'Asia/Dubai', 'Asia/Kolkata', 'Australia/Sydney',
] as const

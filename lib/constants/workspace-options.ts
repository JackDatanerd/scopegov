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

// FIX (fresh independent audit, section 4): added alongside INDUSTRIES/CURRENCIES/
// TIMEZONES above so app/onboarding/page.tsx's Step 2 and api/workspace/defaults/
// route.ts's validation share one list rather than each retyping it. Codes and order
// must stay in sync with components/settings/SettingsClient.tsx's own SOW_LANGUAGES and
// lib/ai/sow-content.ts's SOW_LANGUAGE_NAMES — those two pre-date this file and are left
// alone here to keep this fix scoped to onboarding, but any language added to one list
// needs a matching entry in all three (that guidance already lived on SOW_LANGUAGE_NAMES;
// it now applies here too).
export const SOW_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish (Español)' },
  { code: 'fr', label: 'French (Français)' },
  { code: 'pt', label: 'Portuguese (Português)' },
  { code: 'de', label: 'German (Deutsch)' },
  { code: 'sw', label: 'Swahili (Kiswahili)' },
] as const

export const TIMEZONES = [
  'Africa/Nairobi', 'Africa/Lagos', 'Africa/Accra', 'Africa/Johannesburg', 'Africa/Cairo',
  'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles',
  'Asia/Dubai', 'Asia/Kolkata', 'Australia/Sydney',
] as const

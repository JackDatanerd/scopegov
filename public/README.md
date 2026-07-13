# /public — Favicon & Meta Assets

Drop this entire folder into your project root as `/public`. Next.js serves
everything in `/public` at the site root automatically — no route configuration
needed.

## What's in here

| File | Size | Purpose |
|------|------|---------|
| `favicon.ico` | 16/32/48 multi-size | Classic favicon — browser tab icon |
| `favicon-16x16.png` | 16×16 | Modern browsers, small tab icon |
| `favicon-32x32.png` | 32×32 | Modern browsers, retina tab icon |
| `favicon-48x48.png` | 48×48 | Windows taskbar / high-DPI |
| `apple-touch-icon.png` | 180×180 | iOS home screen icon (opaque — no transparency) |
| `android-chrome-192x192.png` | 192×192 | Android home screen / PWA |
| `android-chrome-512x512.png` | 512×512 | Android splash screen / PWA |
| `mstile-150x150.png` | 150×150 | Windows Start tile (opaque) |
| `safari-pinned-tab.svg` | vector | Safari pinned tab (monochrome, pure black shape) |
| `og-image.png` | 1200×630 | Open Graph / Twitter card preview image |
| `site.webmanifest` | — | PWA manifest — app name, icons, theme colour |
| `browserconfig.xml` | — | Windows tile config |
| `robots.txt` | — | Crawler rules — blocks `/api/`, `/dashboard`, and other private routes |

All PNGs use the ScopeGov forest green (`#1A5C3A`) background with a white
balance-scale mark, matching the in-app design system. The mark simplifies at
smaller sizes (16–48px shows "SG" or "S" in sans-bold; 150px+ shows the full
scale glyph) so it stays legible at every size browsers actually render.

## Required: wire it into `app/layout.tsx`

Next.js App Router picks up `favicon.ico` automatically from `/public` with
zero configuration. Everything else needs to be declared in metadata. Add this
to your root layout:

```typescript
// app/layout.tsx
import type { Metadata } from 'next'

export const metadata: Metadata = {
  metadataBase: new URL('https://www.scopegov.app'),
  title: {
    default: 'ScopeGov — Scope governance for agencies',
    template: '%s · ScopeGov',
  },
  description: 'Scope governance for agencies. SOW generation, Guardian scope monitoring, and change order management.',
  manifest: '/site.webmanifest',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-48x48.png', sizes: '48x48', type: 'image/png' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
    other: [
      { rel: 'mask-icon', url: '/safari-pinned-tab.svg', color: '#1A5C3A' },
    ],
  },
  openGraph: {
    title: 'ScopeGov — Scope governance for agencies',
    description: 'SOW generation, Guardian scope monitoring, and change order management for creative and digital agencies.',
    url: 'https://www.scopegov.app',
    siteName: 'ScopeGov',
    images: [{ url: '/og-image.png', width: 1200, height: 630, alt: 'ScopeGov' }],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ScopeGov — Scope governance for agencies',
    description: 'SOW generation, Guardian scope monitoring, and change order management.',
    images: ['/og-image.png'],
  },
  themeColor: '#1A5C3A',
  applicationName: 'ScopeGov',
}
```

Also add this `<meta>` tag manually in the `<head>` if you want Windows tile
support (Next.js metadata API doesn't have a dedicated field for it):

```typescript
// In the root layout's <head>, alongside your existing Tabler Icons link:
<meta name="msapplication-TileColor" content="#1A5C3A" />
<meta name="msapplication-config" content="/browserconfig.xml" />
```

## Notes

- **`robots.txt`** currently blocks crawlers from `/api/`, `/dashboard`,
  `/projects`, `/clients`, `/settings`, `/team` — all authenticated routes.
  Public marketing pages and the client portal (`/portal/*`) remain crawlable.
  Update the `Sitemap:` line once you have a real sitemap.

- **`og-image.png`** is a static placeholder built from the same brand system
  as the rest of the app. Swap it for a designed version once you have final
  marketing copy — the dimensions (1200×630) and file path are what matter for
  social previews (Twitter, LinkedIn, Slack unfurls, iMessage previews).

- **`safari-pinned-tab.svg`** must stay pure black/transparent — Safari
  recolors it using the `color` attribute in the metadata `mask-icon` entry
  above. Don't add fill colors inside the SVG itself.

- All assets were generated programmatically to match the design system
  (`#1A5C3A` green, matching the sidebar mark). If you get a professional
  logo designed later, regenerate this whole folder from the new mark using
  the same size matrix above — every size listed is required by at least one
  browser/OS combination in current use.

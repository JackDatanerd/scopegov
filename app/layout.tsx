import type { Metadata } from 'next'
// Fonts and the icon font are self-hosted (bundled from npm) rather than loaded from Google Fonts / jsDelivr, so a
// page view never sends the visitor's IP address to a third-party CDN. Same families and weights the old Google
// Fonts URL requested; the families are referenced by name throughout the CSS.
import '@fontsource/cormorant-garamond/300.css'
import '@fontsource/cormorant-garamond/400.css'
import '@fontsource/cormorant-garamond/500.css'
import '@fontsource/cormorant-garamond/600.css'
import '@fontsource/cormorant-garamond/300-italic.css'
import '@fontsource/cormorant-garamond/400-italic.css'
import '@fontsource/ibm-plex-sans/300.css'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@tabler/icons-webfont/dist/tabler-icons.min.css'
import '@/styles/globals.css'

export const metadata: Metadata = {
  metadataBase: new URL('https://www.scopegov.app'),
  title: { default: 'ScopeGov', template: '%s — ScopeGov' },
  description: 'Govern your scope. Keep your revenue.',
  manifest: '/site.webmanifest',
  applicationName: 'ScopeGov',
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
    title: 'ScopeGov',
    description: 'Govern your scope. Keep your revenue.',
    url: 'https://www.scopegov.app',
    siteName: 'ScopeGov',
    images: [{ url: '/og-image.png', width: 1200, height: 630, alt: 'ScopeGov' }],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ScopeGov',
    description: 'Govern your scope. Keep your revenue.',
    images: ['/og-image.png'],
  },
  themeColor: '#1A5C3A',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Windows tile config — no dedicated field in the Next.js metadata API */}
        <meta name="msapplication-TileColor" content="#1A5C3A" />
        <meta name="msapplication-config" content="/browserconfig.xml" />
        {/* Paystack's inline checkout is no longer loaded here — it is injected on demand
            by the Billing tab (components/settings/SettingsClient.tsx), so public client
            portals and every other page stop blocking on a third-party script. */}
      </head>
      <body>{children}</body>
    </html>
  )
}

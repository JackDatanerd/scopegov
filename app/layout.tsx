import type { Metadata } from 'next'
import Script from 'next/script'
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
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.30.0/dist/tabler-icons.min.css"
        />
        {/* Windows tile config — no dedicated field in the Next.js metadata API */}
        <meta name="msapplication-TileColor" content="#1A5C3A" />
        <meta name="msapplication-config" content="/browserconfig.xml" />
        {/* C11: Paystack inline checkout — required for billing upgrade flow */}
        <Script src="https://js.paystack.co/v1/inline.js" strategy="beforeInteractive" />
      </head>
      <body>{children}</body>
    </html>
  )
}

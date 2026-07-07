/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // FIX 4B: @react-pdf/renderer replaces puppeteer-core + @sparticuz/chromium
    serverComponentsExternalPackages: ['@react-pdf/renderer'],
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.supabase.co',
      },
    ],
  },
}

export default nextConfig

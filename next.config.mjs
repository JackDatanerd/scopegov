/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // C9: puppeteer replaced with puppeteer-core + @sparticuz/chromium for Vercel
    serverComponentsExternalPackages: ['puppeteer-core', '@sparticuz/chromium'],
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

// ============================================================
// Next.js 14 Config
// ============================================================

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  transpilePackages: ['@sms-saas/shared'],
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1'}/:path*`,
      },
    ];
  },
  images: {
    domains: [],
  },
};

export default nextConfig;

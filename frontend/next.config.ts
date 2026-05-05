// ============================================================
// Next.js 14 Config
// ============================================================

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Rewrites frontend /api calls to backend (dev only)
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

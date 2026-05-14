// ============================================================
// Next.js 14 Config — wrapped with Sentry for error monitoring
// ============================================================

import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint:    { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  transpilePackages: ['@sms-saas/shared'],

  async rewrites() {
    return [
      {
        source:      '/api/:path*',
        destination: `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1'}/:path*`,
      },
    ];
  },

  images: { domains: [] },
};

export default withSentryConfig(nextConfig, {
  // Source map upload — only runs when auth token is present
  org:       process.env.SENTRY_ORG,
  project:   process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Suppress Sentry CLI output in dev / CI logs
  silent: true,

  // Don't expose source maps in the browser bundle
  hideSourceMaps: true,

  // Suppress Sentry SDK logger in production bundle
  disableLogger: true,

  // Tunnel Sentry requests through the Next.js server to bypass ad-blockers
  tunnelRoute: '/monitoring',
});

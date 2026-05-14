import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn:         process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,

  // Capture 20% of transactions for performance monitoring
  tracesSampleRate: 0.2,

  // Session Replay — record 10% of sessions, 100% on error
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  integrations: [Sentry.replayIntegration()],

  // Only active when DSN is configured
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
});

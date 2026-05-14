// Sentry must be initialized before any other imports.
// This file is the very first import in main.ts.

import * as Sentry from '@sentry/node';

Sentry.init({
  dsn:               process.env.SENTRY_DSN,
  environment:       process.env.NODE_ENV ?? 'development',
  tracesSampleRate:  parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.2'),
  // Only active when DSN is provided — safe to deploy without it
  enabled:           !!process.env.SENTRY_DSN,
});

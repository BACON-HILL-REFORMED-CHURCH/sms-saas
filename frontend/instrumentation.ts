// Next.js 14 instrumentation hook — runs once on server startup.
// Sentry is imported here so it initialises before any route handlers.

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

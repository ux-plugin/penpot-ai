import * as Sentry from "@sentry/react";

// Initialize Sentry for error tracking
export function initSentry() {
  // Only initialize if DSN is provided via environment variable
  const dsn = import.meta.env.VITE_SENTRY_DSN;

  if (!dsn) {
    console.warn("[Sentry] No DSN provided. Error tracking is disabled.");
    return;
  }

  Sentry.init({
    dsn,
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({
        maskAllText: true,
        blockAllMedia: true,
      }),
    ],
    // Performance Monitoring
    tracesSampleRate: 0.1, // Capture 10% of transactions for performance monitoring
    // Session Replay
    replaysSessionSampleRate: 0.1, // Sample 10% of sessions
    replaysOnErrorSampleRate: 1.0, // Sample 100% of sessions with errors
    // Environment
    environment: import.meta.env.MODE || "production",
    // Release tracking
    release: import.meta.env.VITE_APP_VERSION,
  });
}

// Export Sentry for use in error boundaries and manual error reporting
export { Sentry };

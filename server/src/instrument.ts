/**
 * Sentry instrumentation. Imported FIRST in server/src/index.ts (before
 * any other imports) so Sentry can patch http, express, fs, etc. on
 * the way in. Importing after express has already wired its handlers
 * means most auto-instrumentation no-ops silently.
 *
 * When SENTRY_DSN is unset (local dev, test runs), Sentry initializes
 * with `dsn: undefined` and silently skips event submission — no
 * crashes, no leaks. Set the secret in Railway via the dashboard or:
 *   railway variables set SENTRY_DSN=https://...@sentry.io/...
 *
 * `tracesSampleRate: 0.1` keeps perf tracing on for 10% of transactions
 * — enough signal for hot-path latency without burning the free-tier
 * quota. Errors are always captured at 100%.
 *
 * `sendDefaultPii: false` aligns with our privacy posture. Anything
 * we want surfaced (slug, agent_id, request_id) gets explicitly tagged
 * via Sentry.setTag() in the relevant route handlers.
 */
import * as Sentry from "@sentry/node";

Sentry.init({
  dsn:               process.env.SENTRY_DSN,
  environment:       process.env.SENTRY_ENVIRONMENT ?? "production",
  release:           "advocatemcp-server",
  // Apr 28 2026: bumped from 0.1 → 1.0 during initial verification
  // so every request produces a trace. Drop back to 0.1 once Sentry
  // confirms wiring + you want to conserve free-tier transaction
  // quota.
  tracesSampleRate:  1.0,
  sendDefaultPii:    false,
});

// Synthetic startup event so we can verify the DSN works without
// waiting for organic traffic. Fires once per server boot. Look for
// the "advocatemcp-server boot ping" message in Sentry → Issues to
// confirm the connection is live.
Sentry.captureMessage(
  `advocatemcp-server boot ping ${new Date().toISOString()}`,
  "info",
);

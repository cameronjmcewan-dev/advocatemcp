import * as Sentry from "@sentry/cloudflare";

/**
 * Wrap an upstream ReadableStream so read-side failures (TCP RST mid-body,
 * idle-timeout from a flaky origin, etc.) become handled Sentry warnings
 * instead of unhandled `Network connection lost` errors that escape to the
 * Workers runtime's auto-instrumentation.
 *
 * The wrapped stream still errors on upstream failure so the client receives
 * a graceful truncation — the only behaviour change is that one warning
 * lands in Sentry with origin/path tags instead of one paging error.
 */
export function wrapStreamForSentry(
  upstream: ReadableStream<Uint8Array> | null,
  ctx: { tag: string; originHost?: string; path?: string },
): ReadableStream<Uint8Array> | null {
  if (!upstream) return null;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
        }
      } catch (err) {
        Sentry.captureException(err, {
          level: "warning",
          tags: {
            stream_error: ctx.tag,
            origin_host: ctx.originHost ?? "",
            path: ctx.path ?? "",
          },
        });
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
    cancel(reason) {
      upstream.cancel(reason).catch(() => {});
    },
  });
}

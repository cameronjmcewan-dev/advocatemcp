import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Sentry from "@sentry/cloudflare";
import { wrapStreamForSentry } from "./streamWithErrorCapture";

vi.mock("@sentry/cloudflare", () => ({
  captureException: vi.fn(),
}));

describe("wrapStreamForSentry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when upstream is null", () => {
    expect(wrapStreamForSentry(null, { tag: "test" })).toBeNull();
  });

  it("passes chunks through to the wrapped stream on success", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello "));
        c.enqueue(new TextEncoder().encode("world"));
        c.close();
      },
    });
    const wrapped = wrapStreamForSentry(upstream, { tag: "proxyToOrigin" });
    expect(wrapped).not.toBeNull();
    const text = await new Response(wrapped!).text();
    expect(text).toBe("hello world");
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("captures upstream errors to Sentry with tags and errors the wrapped stream", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("partial"));
        c.error(new Error("Network connection lost"));
      },
    });
    const wrapped = wrapStreamForSentry(upstream, {
      tag: "proxyToOrigin",
      originHost: "www.workmancopyco.com",
      path: "/robots.txt",
    });
    await expect(new Response(wrapped!).text()).rejects.toThrow();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        level: "warning",
        tags: expect.objectContaining({
          stream_error: "proxyToOrigin",
          origin_host: "www.workmancopyco.com",
          path: "/robots.txt",
        }),
      }),
    );
  });
});

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { probeDns } from "../../lib/dnsProbe.js";
import { probeLive } from "../../lib/liveProbe.js";

const EXPECTED_CNAME_TARGET = "customers.advocatemcp.com";

const router: Router = Router();

const ProbeSchema = z.object({
  domain: z.string().min(1).max(253),
  slug:   z.string().min(1).max(64),
});

type SignalState = "ok" | "err" | "waiting";
type Signal<D = unknown> = { state: SignalState; message: string; detail?: D };

router.post("/probe-domain", async (req: Request, res: Response) => {
  const parsed = ProbeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid body", issues: parsed.error.issues });
  }
  const { domain, slug } = parsed.data;

  const [dnsResult, liveResult] = await Promise.all([
    probeDns(domain, EXPECTED_CNAME_TARGET),
    probeLive(domain),
  ]);

  const dnsSignal: Signal<{ resolved_target?: string; expected_target: string }> = dnsResult.ok
    ? {
        state: "ok",
        message: "Your CNAME is pointing the right way.",
        detail: { resolved_target: dnsResult.resolved_target, expected_target: EXPECTED_CNAME_TARGET },
      }
    : dnsResult.resolved_target
      ? {
          state: "err",
          message: `Your CNAME points to ${dnsResult.resolved_target} — should be ${EXPECTED_CNAME_TARGET}.`,
          detail: { resolved_target: dnsResult.resolved_target, expected_target: EXPECTED_CNAME_TARGET },
        }
      : {
          state: "waiting",
          message: "Waiting for your CNAME record to propagate. Usually 5–30 minutes.",
          detail: { expected_target: EXPECTED_CNAME_TARGET },
        };

  const placeholder = (msg: string): Signal => ({ state: "waiting", message: msg });

  const liveSignal: Signal<{ status_code?: number; latency_ms?: number; marker_present?: boolean; error?: string }> =
    liveResult.ok
      ? {
          state: "ok",
          message: `Live and serving (${liveResult.latency_ms}ms).`,
          detail: { status_code: liveResult.status_code, latency_ms: liveResult.latency_ms, marker_present: true },
        }
      : {
          state: "err",
          message:
            liveResult.marker_present === false && liveResult.status_code === 200
              ? "Your domain is responding, but the request isn't reaching our worker. Check DNS + CF hostname status above."
              : `Your domain isn't responding yet (${liveResult.error ?? "unknown error"}).`,
          detail: {
            status_code: liveResult.status_code,
            latency_ms: liveResult.latency_ms,
            marker_present: liveResult.marker_present,
            error: liveResult.error,
          },
        };

  const status = {
    domain,
    slug,
    checked_at: new Date().toISOString(),
    signals: {
      dns:          dnsSignal,
      cf_hostname:  placeholder("Waiting on Cloudflare hostname status (filled in by worker)."),
      cf_ssl:       placeholder("Waiting on Cloudflare SSL status (filled in by worker)."),
      worker_route: placeholder("Waiting on Worker route status (filled in by worker)."),
      live_request: liveSignal,
    },
    all_green: dnsSignal.state === "ok" && liveSignal.state === "ok",
  };

  return res.status(200).json(status);
});

export { router as probeDomainRouter };

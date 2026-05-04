export type LiveProbeResult = {
  ok: boolean;
  status_code?: number;
  latency_ms?: number;
  marker_present: boolean;
  error?: string;
};

const PROBE_PATH = "/.well-known/ai-agent.json";
const PROBE_UA   = "PerplexityBot/1.0 (advocate health check)";
const TIMEOUT_MS = 8_000;
const MARKER_KEY = "powered_by";
const MARKER_VAL = "AdvocateMCP";

export async function probeLive(domain: string): Promise<LiveProbeResult> {
  const url = `https://${domain}${PROBE_PATH}`;
  const started = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": PROBE_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (err) {
    return {
      ok: false,
      marker_present: false,
      latency_ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const latency_ms = Date.now() - started;

  if (!res.ok) {
    return {
      ok: false,
      status_code: res.status,
      latency_ms,
      marker_present: false,
      error: `HTTP ${res.status}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return {
      ok: false,
      status_code: res.status,
      latency_ms,
      marker_present: false,
      error: "response was not JSON — request may not be reaching our worker",
    };
  }

  const marker_present =
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as Record<string, unknown>)[MARKER_KEY] === MARKER_VAL;

  if (!marker_present) {
    return {
      ok: false,
      status_code: res.status,
      latency_ms,
      marker_present: false,
      error: "marker missing — request reached the domain but not our worker",
    };
  }

  return { ok: true, status_code: res.status, latency_ms, marker_present: true };
}

export type DnsProbeResult = {
  ok: boolean;
  resolved_target?: string;
  error?: string;
};

const DOH_URL = "https://cloudflare-dns.com/dns-query";
const TIMEOUT_MS = 5_000;

function normalize(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

export async function probeDns(
  domain: string,
  expectedTarget: string,
): Promise<DnsProbeResult> {
  const url = `${DOH_URL}?name=${encodeURIComponent(domain)}&type=CNAME`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (!res.ok) {
    return { ok: false, error: `DoH returned HTTP ${res.status}` };
  }

  let body: { Answer?: Array<{ data: string; type: number }> };
  try {
    body = (await res.json()) as { Answer?: Array<{ data: string; type: number }> };
  } catch {
    return { ok: false, error: "failed to parse DoH response (not JSON)" };
  }

  const cname = body.Answer?.find((a) => a.type === 5);
  if (!cname) {
    return { ok: false, error: "no CNAME record found" };
  }

  const resolved = normalize(cname.data);
  const expected = normalize(expectedTarget);

  if (resolved !== expected) {
    return {
      ok: false,
      resolved_target: resolved,
      error: `CNAME points to ${resolved}, expected ${expected}`,
    };
  }

  return { ok: true, resolved_target: resolved };
}

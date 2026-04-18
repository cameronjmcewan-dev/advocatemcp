/**
 * Minimal Perplexity chat/completions client.
 * Returns the native `citations[]` array, the model's answer text (for
 * downstream sentiment extraction), plus an estimated USD cost.
 *
 * Cost model (v1): flat $0.005/call. Revisit if Perplexity publishes per-token pricing.
 */
const PERPLEXITY_URL   = "https://api.perplexity.ai/chat/completions";
const PERPLEXITY_MODEL = "sonar";
const FLAT_COST_USD    = 0.005;

export interface PerplexityResult {
  citations:  string[];
  answerText: string;
  costUsd:    number;
}

interface PerplexityBody {
  citations?: unknown;
  choices?:   Array<{ message?: { content?: unknown } }>;
}

export async function perplexitySearch(query: string): Promise<PerplexityResult> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error("PERPLEXITY_API_KEY is not set");

  const res = await fetch(PERPLEXITY_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      model: PERPLEXITY_MODEL,
      messages: [{ role: "user", content: query }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const retryAfter = res.headers.get("Retry-After") ?? "unknown";
    throw new Error(`perplexity ${res.status} (retry-after=${retryAfter}): ${body.slice(0, 200)}`);
  }

  const rawBody = await res.text();
  let json: PerplexityBody;
  try {
    json = JSON.parse(rawBody) as PerplexityBody;
  } catch {
    throw new Error(`perplexity json parse failed (status ${res.status}): ${rawBody.slice(0, 200)}`);
  }
  const citations = Array.isArray(json.citations)
    ? json.citations.filter((c): c is string => typeof c === "string")
    : [];
  const firstContent = json.choices?.[0]?.message?.content;
  const answerText = typeof firstContent === "string" ? firstContent : "";
  return { citations, answerText, costUsd: FLAT_COST_USD };
}

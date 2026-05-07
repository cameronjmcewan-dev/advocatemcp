/**
 * Sentiment classification of off-site brand mentions via Claude API.
 * Maps free-text mention → {label: 'positive'|'neutral'|'negative',
 * score: -1..1, theme?: string}.
 *
 * Cost: ~$0.005-$0.01 per mention with claude-sonnet-4-6. Cron caps
 * at 100 mentions/day/tenant to bound spend. The cron MUST de-dup
 * by mention_id so we never classify the same mention twice.
 *
 * Phase 6 PR 1. Uses the existing ANTHROPIC_API_KEY env var.
 */

export interface SentimentResult {
  label:  "positive" | "neutral" | "negative";
  score:  number;  // -1..1; sign matches label, magnitude matches conviction
  theme?: string;  // 1-5 word theme extracted from the mention (optional)
}

const NEUTRAL_DEFAULT: SentimentResult = { label: "neutral", score: 0 };

export async function classifySentiment(
  mentionText: string,
  brandKeyword: string,
  apiKey: string,
): Promise<SentimentResult> {
  const results = await classifySentimentBatch(
    [{ id: "__single__", text: mentionText }],
    brandKeyword,
    apiKey,
  );
  return results[0]?.result ?? NEUTRAL_DEFAULT;
}

export async function classifySentimentBatch(
  mentions: Array<{ id: string; text: string }>,
  brandKeyword: string,
  apiKey: string,
): Promise<Array<{ id: string; result: SentimentResult }>> {
  if (mentions.length === 0) return [];

  const snippetLines = mentions
    .map((m, i) => `${i + 1}. ${m.text.trim()}`)
    .join("\n");

  const prompt = `You are classifying short text snippets where a brand was mentioned. For each input, return:
- label: positive / neutral / negative (about the brand specifically)
- score: a float -1..1 where -1 = strongly negative, 1 = strongly positive, 0 = neutral
- theme: 1-5 words describing what the snippet is ABOUT (e.g. "pricing complaints", "product launch praise")

Brand: ${brandKeyword}

Snippets to classify (numbered):
${snippetLines}

Respond with JSON only, format:
{"results": [{"index": 1, "label": "positive", "score": 0.7, "theme": "service speed"}, ...]}`;

  let resp: Response;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-6",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (err) {
    throw new Error(`sentiment: api failed: network error: ${String(err)}`);
  }

  if (!resp.ok) {
    throw new Error(`sentiment: api failed: ${resp.status}`);
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    return fallbackBatch(mentions);
  }

  const rawText = (body as any)?.content?.[0]?.text as string | undefined;
  if (!rawText) return fallbackBatch(mentions);

  let parsed: { results?: Array<{ index: number; label?: string; score?: number; theme?: string }> };
  try {
    // Claude sometimes wraps JSON in ```json ... ``` — strip fences if present
    const jsonStr = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    parsed = JSON.parse(jsonStr);
  } catch {
    // Parse failure → return neutral defaults for all; never fabricate data
    return fallbackBatch(mentions);
  }

  const resultsArray = parsed?.results;
  if (!Array.isArray(resultsArray)) return fallbackBatch(mentions);

  return mentions.map((m, i) => {
    const row = resultsArray.find((r) => r.index === i + 1);
    if (!row) return { id: m.id, result: NEUTRAL_DEFAULT };

    const label = validateLabel(row.label);
    const score = typeof row.score === "number" ? clamp(row.score, -1, 1) : 0;
    const theme = typeof row.theme === "string" && row.theme.trim() ? row.theme.trim() : undefined;

    return { id: m.id, result: { label, score, theme } };
  });
}

function validateLabel(raw: unknown): SentimentResult["label"] {
  if (raw === "positive" || raw === "neutral" || raw === "negative") return raw;
  return "neutral";
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function fallbackBatch(
  mentions: Array<{ id: string; text: string }>,
): Array<{ id: string; result: SentimentResult }> {
  return mentions.map((m) => ({ id: m.id, result: { ...NEUTRAL_DEFAULT } }));
}

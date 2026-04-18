/**
 * Minimal OpenAI Responses-API client for Competitor Radar P3 v1.1.
 *
 * Uses the built-in `web_search` tool so the model's output carries
 * `url_citation` annotations pointing at the pages it used to answer.
 * Returns the same shape as `perplexitySearch` plus `answerText` for
 * sentiment extraction.
 *
 * Cost model (v1): flat $0.03/call to match OpenAI's list price for
 * web_search tool usage (~6x Perplexity). Revisit when OpenAI publishes
 * per-token/per-search granularity we can read off the response.
 */
const OPENAI_URL       = "https://api.openai.com/v1/responses";
// `gpt-4o-mini` is the cheapest model with documented web_search_preview
// support in the Responses API. Swapped from gpt-4.1-mini which may not
// invoke the tool for every query (observed: audit returned 0 citations
// across 3 queries where Perplexity on the same UI query returned many).
const OPENAI_MODEL     = "gpt-4o-mini";
const FLAT_COST_USD    = 0.03;

export interface OpenAiResult {
  citations: string[];
  answerText: string;
  costUsd:    number;
}

interface ResponsesAnnotation {
  type?: string;
  url?:  string;
}
interface ResponsesContent {
  type?:        string;
  text?:        string;
  annotations?: ResponsesAnnotation[];
}
interface ResponsesOutputItem {
  type?:    string;
  content?: ResponsesContent[];
}
interface ResponsesBody {
  output?:      ResponsesOutputItem[];
  output_text?: string;
}

export async function openaiSearch(query: string): Promise<OpenAiResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: query,
      // `web_search_preview` is the GA tool name in the Responses API
      // as of April 2026 (kept the "preview" suffix even after GA —
      // common source of confusion vs `web_search`). Using the wrong
      // name silently disables the search and the model answers from
      // parametric knowledge only, with NO url_citation annotations.
      tools: [{ type: "web_search_preview" }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const retryAfter = res.headers.get("Retry-After") ?? "unknown";
    throw new Error(`openai ${res.status} (retry-after=${retryAfter}): ${body.slice(0, 200)}`);
  }

  const rawBody = await res.text();
  let json: ResponsesBody;
  try {
    json = JSON.parse(rawBody) as ResponsesBody;
  } catch {
    throw new Error(`openai json parse failed (status ${res.status}): ${rawBody.slice(0, 200)}`);
  }

  const citations: string[] = [];
  const seen = new Set<string>();
  const textParts: string[] = [];

  if (Array.isArray(json.output)) {
    for (const item of json.output) {
      if (!Array.isArray(item.content)) continue;
      for (const c of item.content) {
        if (typeof c.text === "string" && c.text) textParts.push(c.text);
        if (!Array.isArray(c.annotations)) continue;
        for (const a of c.annotations) {
          if (a.type === "url_citation" && typeof a.url === "string" && a.url) {
            if (!seen.has(a.url)) { seen.add(a.url); citations.push(a.url); }
          }
        }
      }
    }
  }

  const answerText = textParts.length > 0
    ? textParts.join("\n")
    : (typeof json.output_text === "string" ? json.output_text : "");

  return { citations, answerText, costUsd: FLAT_COST_USD };
}

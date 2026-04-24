/**
 * Haiku-backed cluster labeler. Called once per new cluster (spawn via
 * incremental nightly job) and once per re-labeled cluster during the
 * weekly full re-cluster. Total weekly cost: ~$0.005 at our scale.
 *
 * PII safety: the prompt explicitly instructs Haiku to strip proper
 * nouns, business names, addresses, phone numbers. These labels may
 * eventually surface in the Tier 1 data product, so we lock PII
 * hygiene at the prompt layer now rather than at external-API-ship time.
 */

import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const LABEL_MODEL = process.env.CLUSTER_LABEL_MODEL ?? "claude-haiku-4-5";

const SYSTEM_PROMPT = `You are labeling a cluster of AI-search user queries that share intent.

RULES:
- Output ONE short topic label, 3-6 words, lowercase, no punctuation.
- The label describes the TOPIC, not a specific instance.
- STRIP all proper nouns: no business names, brand names, street addresses, phone numbers, personal names, or email addresses. If a query mentions "ACME Dental on Main St", the topic is "dental service location".
- No commentary, no explanation. Output only the label.`;

export interface LabelOpts {
  fallbackClusterId?: number;
}

export async function generateClusterLabel(
  queries: string[],
  opts?: LabelOpts,
): Promise<string> {
  // Sample up to 10 queries to keep the prompt small. Haiku input cost
  // is tiny but this also caps prompt token count for rate-limit sanity.
  const sample = queries.slice(0, 10).map((q) => `- ${q}`).join("\n");
  const userContent = `Queries in this cluster:\n${sample}\n\nTopic label:`;

  try {
    const message = await anthropic.messages.create({
      model: LABEL_MODEL,
      max_tokens: 32,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userContent }],
    });
    const raw = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    // Normalize: lowercase, strip trailing punctuation, clamp length
    const cleaned = raw
      .replace(/^["'\s]+|["'\s.,]+$/g, "")
      .toLowerCase()
      .slice(0, 60);
    return cleaned || `topic ${opts?.fallbackClusterId ?? "unknown"}`;
  } catch (err) {
    console.error(JSON.stringify({
      event: "cluster_label_error",
      fallback_cluster_id: opts?.fallbackClusterId,
      error: String(err instanceof Error ? err.message : err),
    }));
    return `topic ${opts?.fallbackClusterId ?? "unknown"}`;
  }
}

import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
  return client;
}

/**
 * Thin wrapper. Returns assistant text, or null on any failure.
 * Callers treat `null` as "LLM unavailable" and fall back.
 */
export async function callClaude(opts: {
  system: string;
  user: string;
  maxTokens: number;
  model?: string;
}): Promise<string | null> {
  try {
    const resp = await getClient().messages.create({
      model: opts.model ?? "claude-sonnet-4-6",
      max_tokens: opts.maxTokens,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
    });
    const texts = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map(b => b.text);
    return texts.join("");
  } catch {
    return null;
  }
}

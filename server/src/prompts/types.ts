export interface BotPromptBlock {
  /** stable module identifier — used in logs and tests */
  name: "perplexity" | "openai" | "claude" | "google" | "training" | "default";
  /** additive text appended to the system prompt after intent emphasis */
  emphasis: string;
}

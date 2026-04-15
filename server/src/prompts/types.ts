export interface BotPromptBlock {
  /** stable module identifier — used in logs and tests */
  name: "perplexity" | "openai" | "claude" | "google" | "training" | "default";
  /** additive text appended to the system prompt after intent emphasis */
  emphasis: string;
}

export type QueryStage = "browsing" | "comparing" | "committing";

export interface StagePromptBlock {
  /** stable module identifier — used in logs and tests */
  name: QueryStage;
  /** additive text appended to the system prompt after the agent block */
  emphasis: string;
}

export interface AgentPromptBlock {
  /** stable module identifier — used in logs and tests */
  name: "claude-desktop" | "cursor" | "gpt-agent" | "default";
  /** additive text appended to the system prompt after the bot block */
  emphasis: string;
}

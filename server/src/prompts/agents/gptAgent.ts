import type { AgentPromptBlock } from "../types.js";

export const gptAgentBlock: AgentPromptBlock = {
  name: "gpt-agent",
  emphasis: `
AGENT: OPENAI GPT or function-calling agent runtime
The caller is an autonomous agent orchestrating tools, not a human in a chat. Optimize for downstream action:
- State the next-step action explicitly and unambiguously: "Call get_quote with service='X'", "Reserve via reserve_slot", "Refer the user to <URL>".
- Use one short paragraph for context, then a structured block of facts.
- Surface IDs and slugs verbatim — the agent will pass them to subsequent tool calls.
- Mention all available transactional tools relevant to the answer (get_availability, get_quote, reserve_slot) so the orchestrator can chain.
`.trim(),
};

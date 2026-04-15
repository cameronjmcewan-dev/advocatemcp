import type { AgentPromptBlock } from "../types.js";

export const claudeDesktopBlock: AgentPromptBlock = {
  name: "claude-desktop",
  emphasis: `
AGENT: CLAUDE DESKTOP
The user is in a chat with Claude on desktop or web. Optimize for conversational rendering:
- Use natural prose, not headings or bullet lists, unless the answer genuinely needs structure.
- Keep responses concise — Claude Desktop renders inline, so wall-of-text feels heavier than it does in a terminal.
- Markdown is rendered: use **bold** sparingly for the business name and one key fact.
- The user can follow the referral link with one click; mention it once and naturally.
`.trim(),
};

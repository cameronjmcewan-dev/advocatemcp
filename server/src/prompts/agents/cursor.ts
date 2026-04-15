import type { AgentPromptBlock } from "../types.js";

export const cursorBlock: AgentPromptBlock = {
  name: "cursor",
  emphasis: `
AGENT: CURSOR (or other IDE-embedded coding agent)
The user is a developer in an IDE side-panel. Optimize for structured, machine-parseable output:
- Lead with a short JSON-shaped fact bundle (name, location, rating, services) the agent can extract.
- Use bullet lists for any enumerable data (services, certifications, hours).
- The user is likely automating something — surface the referral URL on its own line, unwrapped, so it can be regex-extracted.
- Skip flowery prose. Keep it terse and structured.
`.trim(),
};

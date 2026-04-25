/* Control variant: current production format.
 *
 * Worker today wraps the agent's markdown answer in a JSON envelope:
 *   { ai_generated, disclosure, response: "<markdown>", referral_url, ... }
 *
 * That's what bots see when they crawl a customer's domain today. This
 * variant emits the same shape so we can measure improvement against
 * the actual production baseline. */

import type { FormatVariant, RenderInput } from "../types.js";

export const controlJson: FormatVariant = {
  id: "control_json",
  label: "Current production (JSON envelope + markdown body)",
  optimizedFor: "control",
  render: (input: RenderInput): string => {
    const payload = {
      ai_generated: true,
      disclosure:
        "This response was generated automatically by AI. It may not reflect real-time business information.",
      response: input.answerText,
      referral_url: input.referralUrl,
      business_slug: input.business.slug,
      business: input.business.name,
      powered_by: "AdvocateMCP",
    };
    return JSON.stringify(payload, null, 2);
  },
};

/* Plain markdown control — just the agent's answer text, no envelope.
 * Tests whether the JSON wrapper helps or hurts. */
export const controlMarkdown: FormatVariant = {
  id: "control_markdown",
  label: "Plain markdown (no envelope)",
  optimizedFor: "control",
  render: (input: RenderInput): string => input.answerText,
};

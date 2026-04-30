/**
 * Prompt-injection pattern scanner for tenant-supplied free-text fields.
 *
 * AMC-006 defense layer 2 — the layer 1 defense (delimiter wrapping) is
 * in agent/builder.ts. This module rejects content at INPUT time so a
 * compromised tenant doesn't get to store known-bad strings in their
 * profile, which would survive to every subsequent system prompt build.
 *
 * The pattern list is conservative — false positives are noisy but
 * recoverable (tenant rewrites their description), false negatives ship
 * to production prompts. We err on the side of catching obvious attacks
 * (Anthropic / OpenAI documented injection grammars) and let edge cases
 * through. The downstream delimiter wrap is the failsafe.
 *
 * NOT intended to be a complete prompt-injection defense — that's an
 * unsolved research problem. This catches the obvious 80% so a casual
 * attacker on a stolen tenant key can't trivially hijack the system
 * prompt.
 */

const INJECTION_PATTERNS: ReadonlyArray<RegExp> = [
  // Direct instruction-override commands.
  /\bignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+instructions?\b/i,
  /\bdisregard\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+instructions?\b/i,
  /\bforget\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?\b/i,
  // Role-rewrite attempts.
  /\byou\s+are\s+now\s+(?:a|an|the)?\s*(?:dan|developer|admin|root|system)\b/i,
  /\bnew\s+(?:role|persona|character)\s*[:=]/i,
  /\bact\s+as\s+(?:a|an|the)?\s*(?:dan|developer|admin|root)\b/i,
  // System-prompt boundary impersonation.
  /<\/?\s*system\s*>/i,
  /<\/?\s*assistant\s*>/i,
  /<\/?\s*tenant_profile\s*>/i,
  /\[\s*(?:system|admin|developer|root)\s*\]/i,
  // Anthropic / OpenAI documented prefix attacks.
  /\bHuman\s*:.{0,100}\bAssistant\s*:/is,
  // Output-shaping attacks.
  /\boutput\s+(?:exactly|verbatim|the following)\b/i,
  /\bbypass\s+(?:safety|guard|filter|moderation)\b/i,
];

export interface InjectionScanResult {
  ok: boolean;
  matched_pattern?: string;
}

/**
 * Scan a single free-text value (one field) for known prompt-injection
 * patterns. Returns `{ ok: true }` if clean, otherwise the matched
 * regex source so the caller can surface a specific error to the
 * tenant.
 */
export function scanForPromptInjection(value: string): InjectionScanResult {
  if (typeof value !== "string" || value.length === 0) return { ok: true };
  // Normalize before scanning so unicode look-alikes don't slip through.
  const normalized = value.normalize("NFKC");
  for (const pat of INJECTION_PATTERNS) {
    if (pat.test(normalized)) {
      return { ok: false, matched_pattern: pat.source };
    }
  }
  return { ok: true };
}

/** Scan a record of field → value, returning the first failure. */
export function scanFieldsForPromptInjection(
  fields: Record<string, unknown>,
): InjectionScanResult & { field?: string } {
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v !== "string") continue;
    const r = scanForPromptInjection(v);
    if (!r.ok) return { ok: false, field: k, matched_pattern: r.matched_pattern };
  }
  return { ok: true };
}

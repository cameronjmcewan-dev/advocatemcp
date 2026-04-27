#!/usr/bin/env node
/**
 * build-knowledge.mjs — compile a single context-stuffable knowledge base
 * for the marketing-site support assistant from the site, docs, and DNS
 * provider guides.
 *
 * Run automatically via the worker's `predeploy` npm hook before every
 * `wrangler deploy`. Output is `worker/src/lib/knowledgeBase.ts` (a
 * generated TS module exporting a single string constant). Bundled into
 * the worker; injected as the second system block on every support-chat
 * call with cache_control: ephemeral so Anthropic caches it across turns
 * and across sessions for ~10% of base cost on cache hits.
 *
 * Why context stuffing instead of RAG/Vectorize:
 *   - All useful product knowledge is < 50k tokens. Sonnet 4.6 has 1M.
 *   - Prompt caching cuts cached-prefix cost to ~10% of base, so even
 *     stuffing 50k tokens per call is < $0.005 on a cache hit.
 *   - No retrieval roundtrip → faster first token, simpler ops, no
 *     index lifecycle to manage on every Pages deploy.
 *   - Quality: the bot has perfect recall of every fact, not just the
 *     top-K embedding hits.
 *
 * Whitelist (NOT auto-discovered — explicit so internal/sensitive docs
 * stay out): see SITE_PAGES, DOC_FILES, DNS_GUIDES below.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");

// ── Sources ──────────────────────────────────────────────────────────────────
//
// Public-facing only. NEVER add internal/strategy/handoff docs here — the bot
// will leak them word-for-word if asked the right question. Anything in this
// list is fair game for the bot to quote to a customer or prospect.

const SITE_PAGES = [
  "site/Features.html",
  "site/Pricing.html",
  "site/FAQs.html",
  "site/Industries.html",
  "site/methodology.html",
  "site/mcp.html",
  "site/audit.html",
  "site/research/state-of-ai-bot-traffic-q1-2026.html",
];

const DOC_FILES = [
  "docs/attribution.md",
  "docs/bot-detection.md",
  "docs/dns-routing.md",
  "docs/mcp-server.md",
  "docs/response-generation.md",
  "docs/manual-onboarding-runbook.md",
];

// Worker-side DNS provider guides used by the activate page; we keep just
// the human-readable copy from this JS module (the structured data the
// dashboard renders) — the bot doesn't need the JS code itself.
const DNS_GUIDES = [
  "site/js/dns-provider-guides.js",
];

// ── HTML / markdown cleaners ─────────────────────────────────────────────────

/** Strip <script>, <style>, <head>, <nav>, <footer> blocks then tags. */
function cleanHtml(html) {
  let s = html;
  // Drop element ranges that hold no marketing copy.
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, "");
  s = s.replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, "");
  s = s.replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, "");
  s = s.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "");
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "");
  // HTML comments
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // Block-level tags become double newlines so paragraphs survive.
  s = s.replace(/<\/(p|div|section|article|h[1-6]|li|tr|table|ul|ol|blockquote)>/gi, "\n\n");
  // <br> and <li> opens become single newlines.
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  // Remaining tags → strip.
  s = s.replace(/<[^>]+>/g, " ");
  // Decode common entities.
  s = s.replace(/&nbsp;/g, " ");
  s = s.replace(/&amp;/g, "&");
  s = s.replace(/&lt;/g, "<");
  s = s.replace(/&gt;/g, ">");
  s = s.replace(/&quot;/g, '"');
  s = s.replace(/&#39;/g, "'");
  s = s.replace(/&apos;/g, "'");
  s = s.replace(/&mdash;/g, "—");
  s = s.replace(/&ndash;/g, "–");
  s = s.replace(/&hellip;/g, "…");
  // Normalize whitespace: collapse runs of spaces/tabs but preserve
  // blank-line paragraph structure.
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/[ \t]*\n[ \t]*/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** Markdown is mostly fine as-is — strip frontmatter blocks and code-fence
 *  language hints, keep prose structure. */
function cleanMarkdown(md) {
  let s = md;
  // Strip --- frontmatter at file top, if any.
  s = s.replace(/^---\n[\s\S]*?\n---\n/, "");
  // Drop HTML comments embedded in MD (they sometimes hide notes-to-self).
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // Normalize line endings + collapse blank-line runs.
  s = s.replace(/\r\n/g, "\n");
  s = s.replace(/\n{4,}/g, "\n\n\n");
  return s.trim();
}

/** DNS guides are inline JS objects with copy strings. Pull just the
 *  string literals we want (steps, hints, notes); skip the code scaffolding. */
function cleanDnsGuides(js) {
  // Heuristic: extract every string literal that's >= 12 chars and contains
  // a space (filters out variable names, paths, single words). Then dedupe.
  const stringMatcher = /(["'`])((?:\\.|(?!\1).){12,})\1/gms;
  const found = new Set();
  let m;
  while ((m = stringMatcher.exec(js)) !== null) {
    const raw = m[2];
    if (!raw.includes(" ")) continue;
    if (raw.includes("//")) continue;             // skip URL-y or path-y
    if (raw.startsWith("/") || raw.startsWith("@")) continue;
    if (/^[a-z_][a-z0-9_]*$/i.test(raw)) continue; // skip identifier-like
    // Decode escapes minimally.
    const text = raw
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'");
    found.add(text.trim());
  }
  return Array.from(found).join("\n\n");
}

// ── Build ─────────────────────────────────────────────────────────────────────

function readSource(relPath, cleaner) {
  const abs = resolve(REPO_ROOT, relPath);
  const raw = readFileSync(abs, "utf8");
  return cleaner(raw);
}

const sections = [];

sections.push("# AdvocateMCP knowledge base");
sections.push(
  "This is the canonical reference for the support assistant. " +
  "Quote specifics from these sections when answering customer questions. " +
  "If a customer asks about something not covered here, say so honestly and " +
  "hand off to Max via email/phone/Calendly."
);

sections.push("# Marketing site copy\n");
for (const p of SITE_PAGES) {
  try {
    const cleaned = readSource(p, cleanHtml);
    sections.push(`## Source: ${p}\n\n${cleaned}`);
  } catch (err) {
    console.warn(`[build-knowledge] skipping ${p}: ${err.message}`);
  }
}

sections.push("# Public documentation\n");
for (const d of DOC_FILES) {
  try {
    const cleaned = readSource(d, cleanMarkdown);
    sections.push(`## Source: ${d}\n\n${cleaned}`);
  } catch (err) {
    console.warn(`[build-knowledge] skipping ${d}: ${err.message}`);
  }
}

sections.push("# DNS setup guides (per provider)\n");
for (const g of DNS_GUIDES) {
  try {
    const cleaned = readSource(g, cleanDnsGuides);
    sections.push(`## Source: ${g}\n\n${cleaned}`);
  } catch (err) {
    console.warn(`[build-knowledge] skipping ${g}: ${err.message}`);
  }
}

const knowledgeBase = sections.join("\n\n");
const tokenEstimate = Math.round(knowledgeBase.length / 4);
const generatedAt   = new Date().toISOString();

// ── Emit TS module ────────────────────────────────────────────────────────────

const out = `/* eslint-disable */
/**
 * Auto-generated by worker/scripts/build-knowledge.mjs — DO NOT EDIT BY HAND.
 *
 * Run \`npm run build:knowledge\` (or just \`npm run deploy\`, which runs
 * predeploy) to regenerate after editing site copy, docs, or DNS guides.
 *
 * Generated: ${generatedAt}
 * Bytes:     ${knowledgeBase.length}
 * ~Tokens:   ${tokenEstimate} (estimate at 4 chars/token)
 */
export const KNOWLEDGE_BASE: string = ${JSON.stringify(knowledgeBase)};

export const KNOWLEDGE_BASE_META = {
  generated_at:    ${JSON.stringify(generatedAt)},
  bytes:           ${knowledgeBase.length},
  approx_tokens:   ${tokenEstimate},
  source_count:    ${SITE_PAGES.length + DOC_FILES.length + DNS_GUIDES.length},
};
`;

const outPath = resolve(REPO_ROOT, "worker/src/lib/knowledgeBase.ts");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out, "utf8");

console.log(`[build-knowledge] wrote ${outPath}`);
console.log(`[build-knowledge] ${knowledgeBase.length} bytes, ~${tokenEstimate} tokens, ${SITE_PAGES.length + DOC_FILES.length + DNS_GUIDES.length} sources`);

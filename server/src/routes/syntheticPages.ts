/**
 * Public route serving pre-rendered synthetic landing pages
 * (Phase 3 of grey-hat AI optimization layer).
 *
 *   GET /synthetic/:host/*
 *
 * Returns the row from `synthetic_pages` matched by `(host, path)` where
 * `status='live'`. Public — no auth — same posture as
 * /agents/:slug/profile + /agents/:slug/json-ld.json.
 *
 * The worker proxies inbound `/best-{service}-(in|near)-{location}` paths
 * (and the other intent prefixes — affordable, emergency,
 * specific_service) through to this route, passing the request hostname
 * as `:host`. We DO NOT inspect the URL ourselves — the worker does the
 * pattern match before forwarding.
 *
 * Each page emits:
 *   - <title>
 *   - <meta name="description"> (first 160 chars of body)
 *   - <meta name="generator" content="AdvocateMCP synthetic v{N}"> (provenance
 *     anchor — every page is auditable)
 *   - JSON-LD WebPage + LocalBusiness pre-built at generation time
 *   - Markdown body rendered to plain HTML (no JS, no tracking pixels)
 *   - Footer with generation date + source disclosure
 *
 * Apr 28 2026.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { getDb } from "../db.js";

export const syntheticPagesRouter = Router();

interface SyntheticPageRow {
  id:                 number;
  business_id:        number;
  host:               string;
  path:               string;
  title:              string;
  body_md:            string;
  schema_jsonld:      string;
  generator_version:  string;
  generated_at:       number;
  status:             string;
}

/** Minimal markdown→HTML for the body. Bullet lists, paragraphs, **bold**.
 *  We don't allow scripts, embeds, or images — synthetic pages are pure
 *  factual prose. Same anti-XSS posture as the per-bot renderer's
 *  mdBoldToHtml. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderBody(md: string): string {
  // Split into paragraph blocks, then per-block:
  //   - Lines starting with "- " or "* " → <ul><li>
  //   - Lines starting with "## " → <h2>
  //   - Otherwise → <p>
  // **bold** → <strong>
  const blocks = md.split(/\n{2,}/);
  const out: string[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.every((l) => /^[-*]\s+/.test(l.trim()))) {
      out.push(
        "<ul>" +
        lines.map((l) => `<li>${escapeHtml(l.replace(/^[-*]\s+/, "")).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")}</li>`).join("") +
        "</ul>",
      );
    } else if (/^#{1,3}\s+/.test(lines[0]?.trim() ?? "")) {
      const m = lines[0].trim().match(/^(#{1,3})\s+(.+)$/);
      if (m) {
        const level = Math.min(m[1].length + 1, 4);  // # → h2 max h4
        out.push(`<h${level}>${escapeHtml(m[2])}</h${level}>`);
        const rest = lines.slice(1).join("\n").trim();
        if (rest) out.push(`<p>${escapeHtml(rest).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")}</p>`);
      }
    } else {
      out.push(`<p>${escapeHtml(block).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")}</p>`);
    }
  }
  return out.join("\n  ");
}

/**
 * GET /synthetic/:host/*
 *
 * The worker forwards the original hostname as :host and the original
 * pathname as the wildcard tail. We re-assemble (host, path) and look
 * up in `synthetic_pages` where status='live'. 404 when no match.
 */
syntheticPagesRouter.get("/synthetic/:host/*", (req: Request, res: Response) => {
  const host = req.params.host;
  // Express stores wildcard in `req.params[0]`; ensure it begins with '/'.
  const tail = (req.params as Record<string, string>)["0"] ?? "";
  const path = tail.startsWith("/") ? tail : `/${tail}`;

  const flag = (process.env.FEATURE_SYNTHETIC_PAGES ?? "").toLowerCase();
  if (flag !== "true" && flag !== "1") {
    // 404s are deliberately not cached — once the feature flag flips on,
    // Pages should appear immediately rather than waiting for a TTL.
    res.setHeader("Cache-Control", "no-store");
    res.status(404).json({ error: "feature_disabled", flag: "FEATURE_SYNTHETIC_PAGES" });
    return;
  }

  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, business_id, host, path, title, body_md, schema_jsonld,
              generator_version, generated_at, status
         FROM synthetic_pages
         WHERE host = ? AND path = ? AND status = 'live'
         LIMIT 1`,
    )
    .get(host, path) as SyntheticPageRow | undefined;

  if (!row) {
    // No-store on misses so a fresh row going live is reachable on the
    // next request (the worker also bypasses cache on 404).
    res.setHeader("Cache-Control", "no-store");
    res.status(404).json({ error: "not_found", host, path });
    return;
  }

  // Build description from the first sentence of the body. Truncate to
  // 160 chars at a word boundary.
  const desc = (() => {
    const sentence = row.body_md.split(/[.!?]/)[0]?.trim() ?? "";
    if (sentence.length <= 160) return sentence + ".";
    const slice = sentence.slice(0, 160);
    const lastSpace = slice.lastIndexOf(" ");
    return (lastSpace > 100 ? slice.slice(0, lastSpace) : slice) + "…";
  })();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(row.title)}</title>
  <meta name="description" content="${escapeHtml(desc)}">
  <meta name="generator" content="AdvocateMCP ${escapeHtml(row.generator_version)}">
  <meta property="article:published_time" content="${new Date(row.generated_at).toISOString()}">
  <meta property="article:modified_time" content="${new Date(row.generated_at).toISOString()}">
  <link rel="canonical" href="https://${escapeHtml(host)}${escapeHtml(path)}">
  <script type="application/ld+json">
${row.schema_jsonld}
  </script>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; line-height: 1.55; color: #1a1815; }
    h1 { font-size: 2rem; font-weight: 600; margin-bottom: 1rem; }
    article { font-size: 1.05rem; }
    article p { margin: 1rem 0; }
    article ul { padding-left: 1.5rem; }
    footer { font-size: 0.85rem; color: #766f63; border-top: 1px solid #d4ccbf; margin-top: 3rem; padding-top: 1rem; }
  </style>
</head>
<body>
  <article>
    <h1>${escapeHtml(row.title)}</h1>
    ${renderBody(row.body_md)}
  </article>
  <footer>
    <small>This page is generated by AdvocateMCP from the business's verified profile. Last updated: ${new Date(row.generated_at).toISOString().slice(0, 10)}.</small>
  </footer>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Match the worker's edge-cache TTL — 24 h for synthetic pages
  // (per the plan; they change rarely and the validator already
  // gated quality at write time). Worker's cache is the source
  // of truth; we set Cache-Control here as a hint for any
  // downstream proxy.
  res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
  res.send(html);
});

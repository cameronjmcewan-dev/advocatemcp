/**
 * Public route serving generated comparison pages.
 * (Phase 4 of grey-hat AI optimization.)
 *
 *   GET /compare/:host/*
 *
 * Returns the row from `comparison_pages` matched by `(host, path)` where
 * `status='live'`. Public — no auth — same posture as
 * /agents/:slug/profile + /synthetic/:host/*.
 *
 * Worker proxies inbound `/compare/*` paths through to this route, passing
 * the request hostname as `:host`. We DO NOT inspect the URL ourselves —
 * the worker validates the `^/compare/.+-vs-.+/?$` shape before forwarding.
 *
 * Each page emits:
 *   - <title> = comparison title
 *   - <meta name="description"> (first 160 chars of body)
 *   - <meta name="generator" content="AdvocateMCP comparison v{N}">
 *   - JSON-LD WebPage with `about: [LocalBusiness, Organization]` graph
 *   - Markdown body rendered to plain HTML
 *   - Footer with sources disclosure (built into the generated body)
 *
 * Apr 28 2026.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { getDb } from "../db.js";

export const comparisonPagesRouter = Router();

interface ComparisonPageRow {
  id:                 number;
  business_id:        number;
  competitor_id:      number;
  host:               string;
  path:               string;
  body_md:            string;
  schema_jsonld:      string;
  fact_diff_json:     string;
  generator_version:  string;
  generated_at:       number;
  status:             string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Same minimal markdown→HTML as syntheticPagesRouter — keeps the
 *  comparison pages locked to the same anti-XSS posture (no scripts,
 *  no embeds, no images). Bullets, headings, paragraphs, **bold**. */
function renderBody(md: string): string {
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
        const level = Math.min(m[1].length + 1, 4);
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

comparisonPagesRouter.get("/compare/:host/*", (req: Request, res: Response) => {
  const host = req.params.host;
  const tail = (req.params as Record<string, string>)["0"] ?? "";
  // Re-prepend `/compare/` because the route's :host param ate the
  // first path segment. The worker forwards the full original path
  // including `/compare/` so `synthetic_pages.path` lookups stay
  // consistent across the two builders.
  const path = `/compare/${tail.startsWith("/") ? tail.slice(1) : tail}`;

  const flag = (process.env.FEATURE_COMPARISON_PAGES ?? "").toLowerCase();
  if (flag !== "true" && flag !== "1") {
    res.setHeader("Cache-Control", "no-store");
    res.status(404).json({ error: "feature_disabled", flag: "FEATURE_COMPARISON_PAGES" });
    return;
  }

  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, business_id, competitor_id, host, path, body_md,
              schema_jsonld, fact_diff_json, generator_version,
              generated_at, status
         FROM comparison_pages
         WHERE host = ? AND path = ? AND status = 'live'
         LIMIT 1`,
    )
    .get(host, path) as ComparisonPageRow | undefined;

  if (!row) {
    res.setHeader("Cache-Control", "no-store");
    res.status(404).json({ error: "not_found", host, path });
    return;
  }

  // Title is the first H1 / first sentence — comparison body always
  // starts with the comparison title as a heading.
  const title = (() => {
    const m = row.body_md.match(/^#\s+(.+)$/m);
    if (m) return m[1].trim();
    return row.body_md.split(/[.!?]/)[0]?.trim().slice(0, 70) ?? "Comparison";
  })();

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
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(desc)}">
  <meta name="generator" content="AdvocateMCP ${escapeHtml(row.generator_version)}">
  <meta property="article:published_time" content="${new Date(row.generated_at).toISOString()}">
  <meta property="article:modified_time" content="${new Date(row.generated_at).toISOString()}">
  <link rel="canonical" href="https://${escapeHtml(host)}${escapeHtml(path)}">
  <script type="application/ld+json">
${row.schema_jsonld}
  </script>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; line-height: 1.55; color: #1a1815; }
    h1 { font-size: 2rem; font-weight: 600; margin-bottom: 1rem; }
    article { font-size: 1.05rem; }
    article p { margin: 1rem 0; }
    article ul { padding-left: 1.5rem; }
    footer { font-size: 0.85rem; color: #766f63; border-top: 1px solid #d4ccbf; margin-top: 3rem; padding-top: 1rem; }
  </style>
</head>
<body>
  <article>
    ${renderBody(row.body_md)}
  </article>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
  res.send(html);
});

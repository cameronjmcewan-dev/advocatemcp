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

/** Markdown→HTML renderer for comparison pages. Same anti-XSS posture
 *  as syntheticPagesRouter: no scripts, no embeds, no images. Handles:
 *    - `## ` / `### ` headings (h2 / h3, no level-bump)
 *    - `- ` / `* ` bullet lists
 *    - `---` horizontal rule on a line by itself
 *    - Markdown tables (`| a | b |\n|---|---|\n| c | d |`)
 *    - `**bold**` inline
 *
 *  Each block is escaped before any HTML is injected so embedded user
 *  content can't break out of attributes or inject tags. */
function renderBody(md: string): string {
  const inline = (s: string): string =>
    escapeHtml(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  const blocks = md.split(/\n{2,}/);
  const out: string[] = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // Horizontal rule — `---` (or `***`) alone on a line.
    if (/^(?:-{3,}|\*{3,})$/.test(trimmed)) {
      out.push("<hr>");
      continue;
    }

    const lines = block.split("\n");

    // Markdown table. Detect: every line starts and ends with `|`, and
    // the second line is the separator row (`| --- | --- |`-ish).
    const isTable = lines.length >= 2
      && lines.every((l) => /^\s*\|.*\|\s*$/.test(l))
      && /^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$/.test(lines[1] ?? "");
    if (isTable) {
      const cells = (l: string): string[] =>
        l.replace(/^\s*\||\|\s*$/g, "").split("|").map((c) => c.trim());
      const headers = cells(lines[0]!);
      const rows = lines.slice(2).map(cells);
      out.push(
        '<table style="border-collapse:collapse;margin:1rem 0;width:100%">' +
        "<thead><tr>" +
        headers.map((h) => `<th style="text-align:left;padding:0.4rem 0.75rem;border-bottom:2px solid #d4ccbf">${inline(h)}</th>`).join("") +
        "</tr></thead><tbody>" +
        rows.map((r) =>
          "<tr>" +
          r.map((c) => `<td style="padding:0.4rem 0.75rem;border-bottom:1px solid #ece6db">${inline(c)}</td>`).join("") +
          "</tr>",
        ).join("") +
        "</tbody></table>",
      );
      continue;
    }

    // Bullet list — every non-blank line starts with `- ` or `* `.
    if (lines.every((l) => /^[-*]\s+/.test(l.trim()))) {
      out.push(
        "<ul>" +
        lines.map((l) => `<li>${inline(l.replace(/^[-*]\s+/, ""))}</li>`).join("") +
        "</ul>",
      );
      continue;
    }

    // Heading — `## ` / `### ` (or `# `). The body's title heading
    // is the only `##`; section headings inside use `###`. We map
    // 1:1 (no level-bump) — the page already declares <h1> in the
    // article wrapper, so `##` → `<h2>` and `###` → `<h3>` is the
    // canonical SEO-friendly nesting.
    const headingMatch = lines[0]?.trim().match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(Math.max(headingMatch[1].length, 2), 4);
      out.push(`<h${level}>${inline(headingMatch[2])}</h${level}>`);
      const rest = lines.slice(1).join("\n").trim();
      if (rest) out.push(`<p>${inline(rest)}</p>`);
      continue;
    }

    // Default: paragraph.
    out.push(`<p>${inline(block)}</p>`);
  }
  return out.join("\n  ");
}

/** Drop the body's first markdown heading. We render a real <h1> from
 *  the JSON-LD `name` at the top of the article, so the body's `##`
 *  title heading would otherwise duplicate. */
function stripFirstHeading(md: string): string {
  const blocks = md.split(/\n{2,}/);
  let removed = false;
  const out: string[] = [];
  for (const block of blocks) {
    if (!removed && /^#{1,4}\s+/.test(block.trim())) {
      removed = true;
      // If the heading block has trailing content (intro paragraph
      // glued to the heading), preserve that content.
      const lines = block.split("\n");
      const rest = lines.slice(1).join("\n").trim();
      if (rest) out.push(rest);
      continue;
    }
    out.push(block);
  }
  return out.join("\n\n");
}

comparisonPagesRouter.get("/compare/:host/*", (req: Request, res: Response) => {
  const host = req.params.host;
  const tail = (req.params as Record<string, string>)["0"] ?? "";
  // The worker forwards `/compare/{host}{originalPathname}` where
  // `originalPathname` already starts with `/compare/...`. Express's
  // route pattern `/compare/:host/*` consumes the FIRST `/compare/` +
  // the host, so `tail` = `compare/{a}-vs-{b}` (no leading slash). We
  // simply re-add the leading slash to reconstruct the original path
  // — DO NOT prepend `/compare/` again (that was the bug shipped in
  // a7de058: it produced `/compare/compare/{a}-vs-{b}` and missed
  // every DB row).
  const path = tail.startsWith("/") ? tail : `/${tail}`;

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

  // Title — pulled from the persisted JSON-LD `name` field, NOT from
  // the body markdown. The generator already wrote a clean title to
  // schema_jsonld.name; reading it from there avoids the literal `## `
  // markdown chars showing up in <title>. Fall through to a heading
  // scan + first sentence if the schema is malformed.
  const title = (() => {
    try {
      const schema = JSON.parse(row.schema_jsonld) as { name?: string };
      if (typeof schema.name === "string" && schema.name.trim()) {
        return schema.name.trim();
      }
    } catch { /* fall through */ }
    const m = row.body_md.match(/^#{1,3}\s+(.+)$/m);
    if (m) return m[1].trim();
    return row.body_md.split(/[.!?]/)[0]?.trim().slice(0, 70) ?? "Comparison";
  })();

  // Description — first sentence, but skip any leading heading line
  // so we don't pull "## Advocate vs Scrunch AI" into the meta tag.
  const desc = (() => {
    const lines = row.body_md.split("\n");
    const firstNonHeading = lines.find((l) => l.trim() && !/^#{1,4}\s+/.test(l.trim())) ?? "";
    const sentence = firstNonHeading.split(/[.!?]/)[0]?.trim() ?? "";
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
    <h1>${escapeHtml(title)}</h1>
    ${renderBody(stripFirstHeading(row.body_md))}
  </article>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
  res.send(html);
});

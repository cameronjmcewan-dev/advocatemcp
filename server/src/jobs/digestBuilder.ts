/**
 * Weekly digest content builder for Competitor Radar (P5).
 *
 * Pure-ish: reads from the DB given a slug + window, emits `{ subject, html,
 * text, recipient, window }`. Returns `null` for any reason the tenant
 * shouldn't receive a digest this week (missing email, unsubscribed, or no
 * polls in the window). The cron handler (`weeklyDigest.ts`) decides what to
 * do with `null` — record the skip reason, or ignore.
 *
 * The content queries mirror the summary endpoint at
 * `routes/competitorRadar.ts` but deliberately duplicate the SQL rather than
 * import from a shared helper. The queries are 3 short aggregations and the
 * summary endpoint's shape is HTTP-facing — binding the digest to it would
 * couple two different consumers. When a third consumer shows up, extract
 * into `server/src/repos/radar.ts` and refactor both call sites.
 */

import { getDb } from "../db.js";

export interface DigestWindow {
  start_iso: string;
  end_iso:   string;
}

export interface DigestByBot {
  bot:           string;
  total:         number;
  cited:         number;
  citation_rate: number;
  avg_rank:      number | null;
}

export interface DigestLoss {
  phrasing:    string;
  bot:         string;
  top_domains: string[];
}

export interface DigestPayload {
  slug:            string;
  business_name:   string;
  recipient:       string;
  subject:         string;
  html:            string;
  text:            string;
  window:          DigestWindow;
  // Surfaced so callers can log structured stats without re-parsing the body.
  totals: {
    polls:         number;
    cited:         number;
    citation_rate: number;
    // Apr 25 2026: AI-attributed bookings count for the digest window.
    // The most retention-critical number in the email — leads the subject
    // and the body paragraph. Sum of reservations (held + confirmed) plus
    // handoffs delivered to the tenant during the digest window.
    bookings:      number;
  };
}

export interface BuildDigestOptions {
  /** Override trailing window length. Default 7 days. Ignored if `window` is set. */
  rangeDays?:      number;
  /** Explicit window override. Takes precedence over `rangeDays`. */
  window?:         DigestWindow;
  /** Dashboard deep link base, e.g. "https://customers.advocatemcp.com". */
  dashboardUrl?:   string;
  /** Signed unsubscribe URL specific to this tenant. */
  unsubscribeUrl?: string;
}

/** Compute [now - rangeDays, now] as ISO strings, rounded to the current instant. */
export function weekWindow(rangeDays = 7): DigestWindow {
  const end   = new Date();
  const start = new Date(end.getTime() - rangeDays * 24 * 60 * 60 * 1000);
  return { start_iso: start.toISOString(), end_iso: end.toISOString() };
}

/**
 * Day-aligned window for idempotent digest sends. Rounds to UTC midnight
 * so every send within the same UTC day uses the same `window_start_iso`
 * and the (slug, window_start_iso) unique key blocks duplicates.
 */
export function digestWindowForDate(now: Date, rangeDays = 7): DigestWindow {
  const end = new Date(now);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - rangeDays * 24 * 60 * 60 * 1000);
  return { start_iso: start.toISOString(), end_iso: end.toISOString() };
}

export function fmtPct(rate: number): string {
  if (!Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function botLabel(bot: string): string {
  if (bot === "perplexity") return "Perplexity";
  if (bot === "openai")     return "ChatGPT (OpenAI)";
  return bot;
}

interface TenantRow {
  name:                 string;
  email:                string | null;
  digest_unsubscribed:  number;
  plan:                 string;
}

export function buildDigest(
  slug: string,
  opts: BuildDigestOptions = {},
): DigestPayload | null {
  const db = getDb();
  const tenant = db
    .prepare("SELECT name, email, digest_unsubscribed, plan FROM businesses WHERE slug=?")
    .get(slug) as TenantRow | undefined;
  if (!tenant)                           return null;
  if (tenant.plan !== "pro")             return null;
  if (!tenant.email)                     return null;
  if (tenant.digest_unsubscribed === 1)  return null;

  const window       = opts.window ?? weekWindow(opts.rangeDays ?? 7);
  const dashboardUrl = opts.dashboardUrl ?? "https://customers.advocatemcp.com/dashboard";
  const unsubUrl     = opts.unsubscribeUrl ?? "https://customers.advocatemcp.com/digest/unsubscribe";

  const totalsRow = db.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN our_domain_cited=1 THEN 1 ELSE 0 END) AS cited
       FROM competitor_polls
      WHERE slug=? AND polled_at>=? AND polled_at<=?`
  ).get(slug, window.start_iso, window.end_iso) as { total: number; cited: number | null };

  if (totalsRow.total === 0) return null;

  const cited = totalsRow.cited ?? 0;

  // Bookings query — count reservations (held + confirmed) AND handoffs
  // delivered in the digest window for this tenant. Defensive try/catch:
  // if either table is missing (early deploys, fresh DB) we just report
  // 0 bookings rather than failing the whole digest.
  let bookings = 0;
  try {
    const resRow = db.prepare(
      `SELECT COUNT(*) AS n FROM reservations
        WHERE business_slug=? AND status IN ('held', 'confirmed')
          AND created_at>=? AND created_at<=?`
    ).get(slug, window.start_iso, window.end_iso) as { n: number };
    bookings += resRow?.n ?? 0;
  } catch { /* table missing */ }
  try {
    const handoffRow = db.prepare(
      `SELECT COUNT(*) AS n FROM handoffs
        WHERE business_slug=? AND delivered_via IS NOT NULL
          AND created_at>=? AND created_at<=?`
    ).get(slug, window.start_iso, window.end_iso) as { n: number };
    bookings += handoffRow?.n ?? 0;
  } catch { /* table missing */ }

  const totals = {
    polls:         totalsRow.total,
    cited,
    citation_rate: totalsRow.total > 0 ? cited / totalsRow.total : 0,
    bookings,
  };

  const byBotRows = db.prepare(
    `SELECT
       bot,
       COUNT(*) AS total,
       SUM(CASE WHEN our_domain_cited=1 THEN 1 ELSE 0 END) AS cited,
       AVG(CASE WHEN our_domain_cited=1 THEN our_cited_rank END) AS avg_rank
       FROM competitor_polls
      WHERE slug=? AND polled_at>=? AND polled_at<=?
      GROUP BY bot
      ORDER BY bot ASC`
  ).all(slug, window.start_iso, window.end_iso) as {
    bot: string; total: number; cited: number | null; avg_rank: number | null;
  }[];
  const byBot: DigestByBot[] = byBotRows.map((r) => ({
    bot:           r.bot,
    total:         r.total,
    cited:         r.cited ?? 0,
    citation_rate: r.total > 0 ? (r.cited ?? 0) / r.total : 0,
    avg_rank:      r.avg_rank,
  }));

  const descriptorRows = db.prepare(
    `SELECT sentiment_descriptors FROM competitor_polls
      WHERE slug=? AND polled_at>=? AND polled_at<=?
        AND our_domain_cited=1 AND sentiment_descriptors IS NOT NULL`
  ).all(slug, window.start_iso, window.end_iso) as { sentiment_descriptors: string }[];
  const descCounts = new Map<string, number>();
  for (const r of descriptorRows) {
    let arr: unknown;
    try { arr = JSON.parse(r.sentiment_descriptors); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    for (const d of arr) {
      if (typeof d !== "string") continue;
      descCounts.set(d, (descCounts.get(d) ?? 0) + 1);
    }
  }
  const topDescriptors = [...descCounts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([descriptor]) => descriptor);

  // Top 3 lost queries and the competitors that won them. Pick one row per
  // phrasing (DISTINCT) to avoid showing the same query 3 times when we
  // lost it across all 3 phrasing variants.
  const lossRows = db.prepare(
    `SELECT id, phrasing, bot FROM competitor_polls
      WHERE slug=? AND polled_at>=? AND polled_at<=? AND our_domain_cited=0
      GROUP BY phrasing
      ORDER BY polled_at DESC
      LIMIT 3`
  ).all(slug, window.start_iso, window.end_iso) as {
    id: number; phrasing: string; bot: string;
  }[];
  const citationStmt = db.prepare(
    `SELECT domain FROM competitor_citations WHERE poll_id=? ORDER BY rank ASC LIMIT 3`
  );
  const losses: DigestLoss[] = lossRows.map((l) => ({
    phrasing:    l.phrasing,
    bot:         l.bot,
    top_domains: (citationStmt.all(l.id) as { domain: string }[]).map((c) => c.domain),
  }));

  const subject = renderSubject(tenant.name, totals);
  const html    = renderHtml({
    businessName: tenant.name, totals, byBot, topDescriptors, losses,
    dashboardUrl, unsubscribeUrl: unsubUrl,
  });
  const text    = renderText({
    businessName: tenant.name, totals, byBot, topDescriptors, losses,
    dashboardUrl, unsubscribeUrl: unsubUrl,
  });

  return {
    slug,
    business_name: tenant.name,
    recipient:     tenant.email,
    subject,
    html,
    text,
    window,
    totals,
  };
}

function renderSubject(
  businessName: string,
  totals: { polls: number; cited: number; citation_rate: number; bookings: number },
): string {
  const { polls, cited, bookings } = totals;
  // Lead with bookings when there are any — that's the retention-
  // critical number. Fall back to the citation framing when there are
  // no bookings yet (early-tenant case).
  if (bookings > 0) {
    const bookingLabel = bookings === 1 ? "AI booking" : "AI bookings";
    return `${businessName} — ${bookings} ${bookingLabel} this week (+${cited} of ${polls} AI citations)`;
  }
  if (cited === 0) {
    return `${businessName} — 0 of ${polls} AI answers cited you this week`;
  }
  return `${businessName} — cited in ${cited} of ${polls} AI answers this week`;
}

interface RenderData {
  businessName:   string;
  totals:         { polls: number; cited: number; citation_rate: number; bookings: number };
  byBot:          DigestByBot[];
  topDescriptors: string[];
  losses:         DigestLoss[];
  dashboardUrl:   string;
  unsubscribeUrl: string;
}

function renderHtml(d: RenderData): string {
  const { businessName, totals, byBot, topDescriptors, losses, dashboardUrl, unsubscribeUrl } = d;

  const heroRate = fmtPct(totals.citation_rate);
  const byBotRows = byBot.map((r) => `
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;font-size:14px">${escapeHtml(botLabel(r.bot))}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;font-size:14px;text-align:right"><strong>${fmtPct(r.citation_rate)}</strong></td>
      <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#6b7280;text-align:right">${r.cited} / ${r.total}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#6b7280;text-align:right">${r.avg_rank ? r.avg_rank.toFixed(1) : "—"}</td>
    </tr>
  `).join("");

  const descriptorChips = topDescriptors.length > 0
    ? topDescriptors.map((d2) => `<span style="display:inline-block;padding:4px 10px;margin:0 6px 6px 0;border:1px solid #d1d5db;border-radius:999px;font-size:13px;color:#374151;background:#f9fafb">${escapeHtml(d2)}</span>`).join("")
    : `<em style="color:#6b7280;font-size:14px">No descriptors extracted yet — these appear when an AI cites you by name.</em>`;

  const lossBlocks = losses.length > 0
    ? losses.map((l) => `
        <div style="padding:12px 14px;border:1px solid #e5e7eb;border-radius:6px;margin-bottom:8px;background:#ffffff">
          <div style="font-size:14px;color:#111827;margin-bottom:4px"><strong>"${escapeHtml(l.phrasing)}"</strong></div>
          <div style="font-size:12px;color:#6b7280">${escapeHtml(botLabel(l.bot))} cited: ${l.top_domains.slice(0,3).map(escapeHtml).join(", ") || "—"}</div>
        </div>`).join("")
    : `<em style="color:#6b7280;font-size:14px">No lost queries this week — nice week.</em>`;

  return `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111827">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0">
      <tr><td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
          <tr><td style="padding:28px 32px 16px 32px">
            <div style="font-size:12px;color:#6b7280;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:8px">AdvocateMCP · Weekly summary</div>
            <h1 style="margin:0;font-size:22px;color:#111827">${escapeHtml(businessName)}</h1>
            <p style="margin:6px 0 0 0;color:#6b7280;font-size:14px">${
              totals.bookings > 0
                ? `<strong>${totals.bookings} AI ${totals.bookings === 1 ? "booking" : "bookings"} this week.</strong> Plus citation data and lost queries below.`
                : `Here's how AI assistants described your business this week.`
            }</p>
          </td></tr>

          <tr><td style="padding:8px 32px 0 32px">
            <!-- Hero card now leads with bookings count when there are any.
                 Bookings are the retention-critical signal — the closest
                 measurable proof that AI is generating revenue. Falls back
                 to citation rate when no bookings yet (early-tenant case). -->
            ${totals.bookings > 0 ? `
            <div style="padding:20px 24px;background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;margin-bottom:12px">
              <div style="font-size:44px;font-weight:600;color:#0f766e;line-height:1">${totals.bookings}</div>
              <div style="font-size:14px;color:#374151;margin-top:4px">AI-attributed ${totals.bookings === 1 ? "booking" : "bookings"} — agents reserved or completed work for you</div>
            </div>
            ` : ""}
            <div style="padding:20px 24px;background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb">
              <div style="font-size:44px;font-weight:600;color:#111827;line-height:1">${heroRate}</div>
              <div style="font-size:14px;color:#374151;margin-top:4px">cited in ${totals.cited} of ${totals.polls} AI answers</div>
            </div>
          </td></tr>

          <tr><td style="padding:24px 32px 4px 32px">
            <h2 style="font-size:14px;color:#6b7280;letter-spacing:0.04em;text-transform:uppercase;margin:0 0 8px 0">Share of Model</h2>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
              <thead>
                <tr>
                  <th style="padding:8px 14px;border-bottom:2px solid #e5e7eb;text-align:left;font-size:12px;color:#6b7280;font-weight:500">Provider</th>
                  <th style="padding:8px 14px;border-bottom:2px solid #e5e7eb;text-align:right;font-size:12px;color:#6b7280;font-weight:500">Rate</th>
                  <th style="padding:8px 14px;border-bottom:2px solid #e5e7eb;text-align:right;font-size:12px;color:#6b7280;font-weight:500">Cited</th>
                  <th style="padding:8px 14px;border-bottom:2px solid #e5e7eb;text-align:right;font-size:12px;color:#6b7280;font-weight:500">Avg rank</th>
                </tr>
              </thead>
              <tbody>${byBotRows}</tbody>
            </table>
          </td></tr>

          <tr><td style="padding:24px 32px 4px 32px">
            <h2 style="font-size:14px;color:#6b7280;letter-spacing:0.04em;text-transform:uppercase;margin:0 0 10px 0">How AI described you</h2>
            <div>${descriptorChips}</div>
          </td></tr>

          <tr><td style="padding:24px 32px 4px 32px">
            <h2 style="font-size:14px;color:#6b7280;letter-spacing:0.04em;text-transform:uppercase;margin:0 0 10px 0">Queries you lost</h2>
            ${lossBlocks}
          </td></tr>

          <tr><td style="padding:28px 32px 32px 32px" align="center">
            <a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;padding:12px 24px;background:#0f766e;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:500">View full dashboard →</a>
          </td></tr>
        </table>

        <table width="600" cellpadding="0" cellspacing="0" style="margin-top:12px">
          <tr><td style="padding:0 32px;font-size:11px;color:#9ca3af;text-align:center;line-height:1.5">
            You're receiving this because your AdvocateMCP Pro plan includes Competitor Radar.<br>
            <a href="${escapeHtml(unsubscribeUrl)}" style="color:#9ca3af;text-decoration:underline">Unsubscribe from digests</a> · AdvocateMCP
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

function renderText(d: RenderData): string {
  const { businessName, totals, byBot, topDescriptors, losses, dashboardUrl, unsubscribeUrl } = d;
  const lines: string[] = [];
  lines.push(`${businessName} — AdvocateMCP weekly summary`);
  lines.push("");
  if (totals.bookings > 0) {
    lines.push(`AI-attributed bookings: ${totals.bookings} ${totals.bookings === 1 ? "booking" : "bookings"} this week (agents reserved or completed work for you)`);
    lines.push("");
  }
  lines.push(`Citation rate: ${fmtPct(totals.citation_rate)} (cited in ${totals.cited} of ${totals.polls} AI answers)`);
  lines.push("");
  lines.push("SHARE OF MODEL");
  for (const r of byBot) {
    const rank = r.avg_rank ? ` · avg rank ${r.avg_rank.toFixed(1)}` : "";
    lines.push(`  ${botLabel(r.bot)}: ${fmtPct(r.citation_rate)} (${r.cited}/${r.total})${rank}`);
  }
  lines.push("");
  lines.push("HOW AI DESCRIBED YOU");
  lines.push(topDescriptors.length > 0
    ? `  ${topDescriptors.join(", ")}`
    : "  (no descriptors yet — AI hasn't cited you by name)");
  lines.push("");
  lines.push("QUERIES YOU LOST");
  if (losses.length === 0) {
    lines.push("  (none)");
  } else {
    for (const l of losses) {
      lines.push(`  "${l.phrasing}" [${botLabel(l.bot)}]`);
      lines.push(`    → ${l.top_domains.slice(0, 3).join(", ") || "—"}`);
    }
  }
  lines.push("");
  lines.push(`Full dashboard: ${dashboardUrl}`);
  lines.push("");
  lines.push(`Unsubscribe from digests: ${unsubscribeUrl}`);
  return lines.join("\n");
}

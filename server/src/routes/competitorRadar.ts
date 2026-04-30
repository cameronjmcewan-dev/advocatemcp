import { Router } from "express";
import type { Request, Response } from "express";
// AMC-004: removed requireApiKey usage — every endpoint here is slug-scoped.
import { requireSlugOrAdminKey } from "../middleware/auth.js";
import { getDb } from "../db.js";
import { canonicalDomain } from "../lib/domainMatch.js";

export const competitorRadarRouter = Router();

function parseDays(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 365 ? Math.floor(n) : fallback;
}
function parseLimit(raw: unknown, fallback: number, cap: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), cap);
}
function daysAgoIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

const KNOWN_BOTS = new Set(["perplexity", "openai"]);
/** Accept ?bot=perplexity|openai; any other value (including "all") → null (no filter). */
function parseBot(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.toLowerCase().trim();
  return KNOWN_BOTS.has(v) ? v : null;
}

/**
 * GET /api/competitor-radar/:slug/summary?days=30&bot=perplexity
 *
 * Response shape:
 *   {
 *     range_days, total_polls, cited_count, citation_rate, avg_cited_rank,
 *     top_competitor_domains[], last_polled_at,
 *     by_bot:            [{bot, total, cited, citation_rate, avg_rank}],
 *     top_descriptors:   [{descriptor, count}],
 *     bot:               "perplexity" | "openai" | null  // echo of ?bot filter
 *   }
 *
 * Top-level counts are filtered by ?bot when provided; `by_bot` always
 * breaks down every provider the tenant has polled against in the window.
 */
competitorRadarRouter.get(
  "/api/competitor-radar/:slug/summary",
  requireSlugOrAdminKey,
  (req: Request, res: Response) => {
    const { slug } = req.params;
    const days = parseDays(req.query.days, 30);
    const bot  = parseBot(req.query.bot);
    const since = daysAgoIso(days);
    const db = getDb();

    const biz = db.prepare("SELECT website FROM businesses WHERE slug=?")
      .get(slug) as { website: string | null } | undefined;
    if (!biz) { res.status(404).json({ error: "not_found" }); return; }
    const ownDomain = canonicalDomain(biz.website ?? "");

    // Build WHERE + bind values once; reuse across the aggregate queries so
    // the ?bot filter is applied consistently. `whereBotCp` is the
    // table-qualified variant used inside the top-competitor-domains JOIN.
    const whereBot     = bot ? " AND bot=?"    : "";
    const whereBotCp   = bot ? " AND cp.bot=?" : "";
    const bindBot      = bot ? [bot] as const  : [] as const;

    const polls = db.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN our_domain_cited=1 THEN 1 ELSE 0 END) AS cited,
         AVG(CASE WHEN our_domain_cited=1 THEN our_cited_rank END) AS avg_rank,
         MAX(polled_at) AS last_polled_at
       FROM competitor_polls
       WHERE slug=? AND polled_at>=?${whereBot}`
    ).get(slug, since, ...bindBot) as {
      total: number; cited: number | null; avg_rank: number | null; last_polled_at: string | null;
    };

    const top = db.prepare(
      `SELECT cc.domain, COUNT(*) AS cited_count
         FROM competitor_citations cc
         JOIN competitor_polls cp ON cp.id = cc.poll_id
        WHERE cp.slug=? AND cp.polled_at>=? AND cp.our_domain_cited=0 AND cc.domain <> ?${whereBotCp}
        GROUP BY cc.domain
        ORDER BY cited_count DESC
        LIMIT 5`
    ).all(slug, since, ownDomain, ...bindBot) as { domain: string; cited_count: number }[];

    // Per-provider breakdown. Ignores ?bot — the whole point is to compare.
    const byBotRows = db.prepare(
      `SELECT
         bot,
         COUNT(*) AS total,
         SUM(CASE WHEN our_domain_cited=1 THEN 1 ELSE 0 END) AS cited,
         AVG(CASE WHEN our_domain_cited=1 THEN our_cited_rank END) AS avg_rank
       FROM competitor_polls
       WHERE slug=? AND polled_at>=?
       GROUP BY bot
       ORDER BY bot ASC`
    ).all(slug, since) as { bot: string; total: number; cited: number | null; avg_rank: number | null }[];
    const by_bot = byBotRows.map((r) => ({
      bot:           r.bot,
      total:         r.total,
      cited:         r.cited ?? 0,
      citation_rate: r.total > 0 ? (r.cited ?? 0) / r.total : 0,
      avg_rank:      r.avg_rank,
    }));

    // Top sentiment descriptors across cited polls in the window. Decoded
    // in JS rather than with SQLite JSON1 to keep the build free of the
    // optional json1 dependency, which isn't guaranteed on every build.
    const descriptorRows = db.prepare(
      `SELECT sentiment_descriptors FROM competitor_polls
        WHERE slug=? AND polled_at>=? AND our_domain_cited=1 AND sentiment_descriptors IS NOT NULL${whereBot}`
    ).all(slug, since, ...bindBot) as { sentiment_descriptors: string }[];
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
    const top_descriptors = [...descCounts.entries()]
      .map(([descriptor, count]) => ({ descriptor, count }))
      .sort((a, b) => (b.count - a.count) || a.descriptor.localeCompare(b.descriptor))
      .slice(0, 10);

    res.json({
      range_days: days,
      total_polls: polls.total,
      cited_count: polls.cited ?? 0,
      citation_rate: polls.total > 0 ? (polls.cited ?? 0) / polls.total : 0,
      avg_cited_rank: polls.avg_rank,
      top_competitor_domains: top,
      last_polled_at: polls.last_polled_at,
      by_bot,
      top_descriptors,
      bot,
    });
  },
);

/**
 * GET /api/competitor-radar/:slug/authority-report?days=30&bot=&limit=20
 *
 * "Who does AI consider authoritative in this tenant's category?" —
 * aggregates every citation across every poll the tenant has run in the
 * window, counts how many polls each third-party domain appears in, and
 * breaks each down by which AI provider cited it.
 *
 * Unlike the summary's `top_competitor_domains` (which filters to polls
 * where the tenant was NOT cited — sector rivals only), this report
 * includes all polls, so the universe is "every source AI reached for
 * when asked about your category," including directories and review
 * sites (Yelp, Angi, Martindale, BBB, etc.). That's the actionable set
 * for off-site authority work.
 *
 * Response shape:
 *   {
 *     range_days, bot,
 *     total_polls, domains_seen,
 *     authorities: [
 *       { domain, polls_cited_in, share_of_polls,
 *         by_bot: [{bot, count}] }
 *     ]
 *   }
 */
competitorRadarRouter.get(
  "/api/competitor-radar/:slug/authority-report",
  requireSlugOrAdminKey,
  (req: Request, res: Response) => {
    const { slug } = req.params;
    const days  = parseDays(req.query.days, 30);
    const bot   = parseBot(req.query.bot);
    const limit = parseLimit(req.query.limit, 20, 100);
    const since = daysAgoIso(days);
    const db = getDb();

    const biz = db.prepare("SELECT website FROM businesses WHERE slug=?")
      .get(slug) as { website: string | null } | undefined;
    if (!biz) { res.status(404).json({ error: "not_found" }); return; }
    const ownDomain = canonicalDomain(biz.website ?? "");

    const whereBot = bot ? " AND cp.bot=?" : "";
    const bindBot  = bot ? [bot] as const : [] as const;

    const { total_polls } = db.prepare(
      `SELECT COUNT(*) AS total_polls FROM competitor_polls cp
        WHERE cp.slug=? AND cp.polled_at>=?${whereBot}`
    ).get(slug, since, ...bindBot) as { total_polls: number };

    // DISTINCT poll_id per (domain, bot) — a single poll that cites the
    // same domain three times should count once. GROUP BY domain gives the
    // global rank; the second pass pulls the bot breakdown.
    const domainRows = db.prepare(
      `SELECT cc.domain, COUNT(DISTINCT cc.poll_id) AS polls_cited_in
         FROM competitor_citations cc
         JOIN competitor_polls cp ON cp.id = cc.poll_id
        WHERE cp.slug=? AND cp.polled_at>=? AND cc.domain <> ? AND cc.domain <> ''${whereBot}
        GROUP BY cc.domain
        ORDER BY polls_cited_in DESC, cc.domain ASC
        LIMIT ?`
    ).all(slug, since, ownDomain, ...bindBot, limit) as {
      domain: string; polls_cited_in: number;
    }[];

    // Per-bot breakdown for the surfaced domains only — bounded by `limit`
    // so the query stays fast even when the citation set is large.
    let byBotByDomain = new Map<string, { bot: string; count: number }[]>();
    if (domainRows.length > 0) {
      const placeholders = domainRows.map(() => "?").join(",");
      const botRows = db.prepare(
        `SELECT cc.domain, cp.bot, COUNT(DISTINCT cc.poll_id) AS count
           FROM competitor_citations cc
           JOIN competitor_polls cp ON cp.id = cc.poll_id
          WHERE cp.slug=? AND cp.polled_at>=? AND cc.domain IN (${placeholders})${whereBot}
          GROUP BY cc.domain, cp.bot
          ORDER BY cc.domain ASC, cp.bot ASC`
      ).all(slug, since, ...domainRows.map((d) => d.domain), ...bindBot) as {
        domain: string; bot: string; count: number;
      }[];
      for (const r of botRows) {
        const list = byBotByDomain.get(r.domain) ?? [];
        list.push({ bot: r.bot, count: r.count });
        byBotByDomain.set(r.domain, list);
      }
    }

    const authorities = domainRows.map((r) => ({
      domain:         r.domain,
      polls_cited_in: r.polls_cited_in,
      share_of_polls: total_polls > 0 ? r.polls_cited_in / total_polls : 0,
      by_bot:         byBotByDomain.get(r.domain) ?? [],
    }));

    res.json({
      range_days:   days,
      bot,
      total_polls,
      domains_seen: authorities.length,
      authorities,
    });
  },
);

/**
 * GET /api/competitor-radar/:slug/losses?days=7&limit=50&bot=openai
 */
competitorRadarRouter.get(
  "/api/competitor-radar/:slug/losses",
  requireSlugOrAdminKey,
  (req: Request, res: Response) => {
    const { slug } = req.params;
    const days  = parseDays(req.query.days, 7);
    const limit = parseLimit(req.query.limit, 50, 200);
    const bot   = parseBot(req.query.bot);
    const since = daysAgoIso(days);
    const db = getDb();

    const whereBot = bot ? " AND bot=?" : "";
    const bindBot  = bot ? [bot] as const : [] as const;

    const polls = db.prepare(
      `SELECT id, polled_at, phrasing, phrasing_variant, bot
         FROM competitor_polls
        WHERE slug=? AND polled_at>=? AND our_domain_cited=0${whereBot}
        ORDER BY polled_at DESC
        LIMIT ?`
    ).all(slug, since, ...bindBot, limit) as {
      id: number; polled_at: string; phrasing: string; phrasing_variant: number; bot: string;
    }[];

    const citationStmt = db.prepare(
      `SELECT rank, domain, title FROM competitor_citations
        WHERE poll_id=? ORDER BY rank ASC LIMIT 5`
    );

    const losses = polls.map((p) => ({
      poll_id:   p.id,
      polled_at: p.polled_at,
      phrasing:  p.phrasing,
      variant:   p.phrasing_variant,
      bot:       p.bot,
      top_citations: citationStmt.all(p.id),
    }));

    res.json({ range_days: days, bot, losses });
  },
);

const BASKET_CAP = 15;
const QUERY_MAX  = 200;

/**
 * GET /api/competitor-basket/:slug
 */
competitorRadarRouter.get(
  "/api/competitor-basket/:slug",
  requireSlugOrAdminKey,
  (req: Request, res: Response) => {
    const { slug } = req.params;
    const db = getDb();
    const queries = db.prepare(
      `SELECT id, query, source FROM competitor_query_baskets
        WHERE slug=? AND enabled=1
        ORDER BY created_at ASC`
    ).all(slug) as { id: number; query: string; source: string }[];
    res.json({ slug, queries });
  },
);

/**
 * POST /api/competitor-basket/:slug/queries
 */
competitorRadarRouter.post(
  "/api/competitor-basket/:slug/queries",
  requireSlugOrAdminKey,
  (req: Request, res: Response) => {
    const { slug } = req.params;
    const raw = typeof req.body?.query === "string" ? req.body.query.trim() : "";
    if (!raw || raw.length > QUERY_MAX) {
      res.status(400).json({ error: "query must be 1..200 chars" });
      return;
    }

    const db = getDb();
    const { count } = db.prepare(
      "SELECT COUNT(*) AS count FROM competitor_query_baskets WHERE slug=? AND enabled=1"
    ).get(slug) as { count: number };
    if (count >= BASKET_CAP) {
      res.status(400).json({ error: `basket cap reached (${BASKET_CAP} enabled queries)` });
      return;
    }

    try {
      const info = db.prepare(
        `INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
         VALUES (?, ?, 'tenant', 1, ?)`
      ).run(slug, raw, new Date().toISOString());
      res.status(201).json({ id: Number(info.lastInsertRowid), slug, query: raw, source: "tenant" });
    } catch (err) {
      if (err instanceof Error && /UNIQUE/i.test(err.message)) {
        res.status(409).json({ error: "duplicate query for this tenant" });
        return;
      }
      throw err;
    }
  },
);

/**
 * DELETE /api/competitor-basket/:slug/queries/:id  — soft delete
 */
competitorRadarRouter.delete(
  "/api/competitor-basket/:slug/queries/:id",
  requireSlugOrAdminKey,
  (req: Request, res: Response) => {
    const { slug, id } = req.params;
    const numId = Number(id);
    if (!Number.isFinite(numId)) { res.status(404).json({ error: "not_found" }); return; }

    const db = getDb();
    const info = db.prepare(
      "UPDATE competitor_query_baskets SET enabled=0 WHERE id=? AND slug=? AND enabled=1"
    ).run(numId, slug);
    if (info.changes === 0) { res.status(404).json({ error: "not_found" }); return; }
    res.json({ ok: true });
  },
);

/**
 * GET /api/competitor-radar/:slug/share-of-voice/weekly?weeks=12
 *
 * Phase A of the dashboard redesign. Returns a weekly time series of
 * citation share — what % of polls cited the tenant's domain — for the
 * past N weeks (default 12, max 52). Bucketed by ISO week start (Monday).
 *
 * Response shape:
 *   {
 *     range_weeks: 12,
 *     series: [
 *       { week_start: "2026-02-09", polls: 14, cited: 6, share: 0.43 },
 *       { week_start: "2026-02-16", polls: 18, cited: 8, share: 0.44 },
 *       ...
 *     ]
 *   }
 *
 * Powers the "Share of Voice" line chart card on the customer dashboard
 * (renders `share` over time). Weeks with zero polls are emitted with
 * `share: 0` and a flag so the renderer can dot-mark them as "no data".
 */
competitorRadarRouter.get(
  "/api/competitor-radar/:slug/share-of-voice/weekly",
  requireSlugOrAdminKey,
  (req: Request, res: Response) => {
    const { slug } = req.params;
    const weeks = (() => {
      const n = Number(req.query.weeks);
      return Number.isFinite(n) && n > 0 && n <= 52 ? Math.floor(n) : 12;
    })();
    const db = getDb();

    // SQLite weekday: %w returns 0=Sun..6=Sat. We want Monday-anchored
    // weeks (ISO 8601). Convert to Monday by subtracting (weekday + 6) % 7
    // days from each row's polled_at; SQLite makes that idiomatic via
    // strftime + julianday math.
    const rows = db.prepare(
      `SELECT
         DATE(polled_at, 'weekday 0', '-6 days') AS week_start,
         COUNT(*)                                AS polls,
         SUM(our_domain_cited)                   AS cited
       FROM competitor_polls
       WHERE slug = ?
         AND polled_at >= DATE('now', ?)
       GROUP BY week_start
       ORDER BY week_start ASC`,
    ).all(slug, `-${weeks * 7} days`) as Array<{
      week_start: string; polls: number; cited: number;
    }>;

    // Pad missing weeks so the chart is contiguous. Walk from N weeks ago
    // to today in 7-day strides; for each week not present in `rows`,
    // emit a zero-poll entry. The padding ensures the line chart's x-axis
    // is uniform regardless of polling cadence gaps.
    const byWeek = new Map<string, { polls: number; cited: number }>();
    for (const r of rows) byWeek.set(r.week_start, { polls: r.polls, cited: r.cited ?? 0 });

    // Resolve "this week's Monday" — the most recent Monday on or before
    // today, in UTC.
    const todayMs = Date.now();
    const today = new Date(todayMs);
    const dow = today.getUTCDay();                 // 0=Sun..6=Sat
    const daysToMon = (dow + 6) % 7;               // 0 if today is Mon
    const thisMonday = new Date(today);
    thisMonday.setUTCDate(today.getUTCDate() - daysToMon);
    thisMonday.setUTCHours(0, 0, 0, 0);

    const series: Array<{
      week_start: string; polls: number; cited: number; share: number;
    }> = [];
    for (let i = weeks - 1; i >= 0; i--) {
      const d = new Date(thisMonday);
      d.setUTCDate(thisMonday.getUTCDate() - i * 7);
      const key = d.toISOString().slice(0, 10);
      const bucket = byWeek.get(key) ?? { polls: 0, cited: 0 };
      const share = bucket.polls > 0 ? bucket.cited / bucket.polls : 0;
      series.push({
        week_start: key,
        polls:      bucket.polls,
        cited:      bucket.cited,
        share:      Number(share.toFixed(4)),
      });
    }

    res.json({ range_weeks: weeks, series });
  },
);

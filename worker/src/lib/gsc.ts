/**
 * Thin TypeScript client for the Google Search Console (Webmasters)
 * API. Pulls the customer's verified site list (post-OAuth picker)
 * + per-day per-query search analytics (impressions, clicks, ctr,
 * position).
 *
 * Errors are prefixed "gsc:" so cron logs are grep-friendly.
 *
 * AI Overview detection (searchAppearance: aiOverview filter) shipped
 * in Phase 3 PR 4 via fetchAiOverviewQueries below.
 */

export interface GSCSite {
  siteUrl:         string;   // "https://example.com/"
  permissionLevel: string;   // "siteOwner" | "siteFullUser" | etc.
}

export interface GSCSearchRow {
  date:        string;   // YYYY-MM-DD
  query:       string;
  impressions: number;
  clicks:      number;
  ctr:         number;   // 0..1
  position:    number;   // 1.0+ (lower is better)
}

// ── listSites ─────────────────────────────────────────────────────────────────

export async function listSites(accessToken: string): Promise<GSCSite[]> {
  const res = await fetch(
    "https://searchconsole.googleapis.com/webmasters/v3/sites",
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 200);
    throw new Error(`gsc: listSites failed: ${res.status} ${snippet}`);
  }

  // Typed inline to avoid `any`
  const json = (await res.json()) as {
    siteEntry?: Array<{
      siteUrl:         string;
      permissionLevel: string;
    }>;
  };

  // Filter to sites the customer can actually pull data from. Unverified
  // sites (permissionLevel="siteUnverifiedUser") can't be queried via
  // the Search Analytics API.
  return (json.siteEntry ?? []).filter(
    (e) => e.permissionLevel === "siteOwner" || e.permissionLevel === "siteFullUser",
  );
}

// ── fetchSearchAnalytics ──────────────────────────────────────────────────────

export async function fetchSearchAnalytics(opts: {
  siteUrl:     string;
  startDate:   string;   // YYYY-MM-DD
  endDate:     string;
  accessToken: string;
  rowLimit?:   number;   // default 25000 (GSC max)
}): Promise<GSCSearchRow[]> {
  const { siteUrl, startDate, endDate, accessToken, rowLimit = 25000 } = opts;

  // GSC requires siteUrl to be URL-encoded in the path
  // e.g. "https://example.com/" → "https%3A%2F%2Fexample.com%2F"
  const encodedSiteUrl = encodeURIComponent(siteUrl);

  const res = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodedSiteUrl}/searchAnalytics/query`,
    {
      method: "POST",
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startDate,
        endDate,
        dimensions: ["date", "query"],
        rowLimit,
      }),
    },
  );

  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 200);
    throw new Error(`gsc: searchAnalytics failed: ${res.status} ${snippet}`);
  }

  // Typed inline — GSC Search Analytics row shape
  const json = (await res.json()) as {
    rows?: Array<{
      keys:        [string, string];   // [date, query]
      clicks:      number;
      impressions: number;
      ctr:         number;
      position:    number;
    }>;
  };

  const rows: GSCSearchRow[] = [];
  for (const row of json.rows ?? []) {
    // GSC returns dates with hyphens natively (YYYY-MM-DD) — no conversion needed
    rows.push({
      date:        row.keys[0],
      query:       row.keys[1],
      impressions: row.impressions,
      clicks:      row.clicks,
      ctr:         row.ctr,
      position:    row.position,
    });
  }
  return rows;
}

// ── fetchAiOverviewQueries ────────────────────────────────────────────────────

/**
 * Per-day per-query rows where Google's AI Overview appeared at search
 * time. Returns the SUBSET of fetchSearchAnalytics' results — same row
 * shape (minus ctr/position which aren't meaningful for this filtered
 * view), but filtered by searchAppearance=aiOverview at API time so
 * the response only contains queries that triggered an Overview.
 *
 * Phase 3 PR 4 of the Traffic Impact data-depth roadmap. Used by
 * gscSync to set ai_overview_shown=1 on matching gsc_daily rows.
 *
 * Note on Google's data lag: AI Overview presence is reported with the
 * SAME 2-3 day lag as the base search analytics. Aligning the date
 * windows between fetchSearchAnalytics and fetchAiOverviewQueries is
 * the caller's responsibility (cron + select-site already pull the
 * same window for both, so this aligns naturally).
 */
export async function fetchAiOverviewQueries(opts: {
  siteUrl:     string;
  startDate:   string;   // YYYY-MM-DD
  endDate:     string;
  accessToken: string;
  rowLimit?:   number;   // default 25000
}): Promise<Array<{ date: string; query: string; impressions: number; clicks: number }>> {
  const { siteUrl, startDate, endDate, accessToken, rowLimit = 25000 } = opts;

  const encodedSiteUrl = encodeURIComponent(siteUrl);

  const res = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodedSiteUrl}/searchAnalytics/query`,
    {
      method: "POST",
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startDate,
        endDate,
        dimensions: ["date", "query"],
        dimensionFilterGroups: [{
          filters: [{
            dimension:  "searchAppearance",
            operator:   "equals",
            expression: "aiOverview",
          }],
        }],
        rowLimit,
      }),
    },
  );

  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 200);
    throw new Error(`gsc: aiOverview query failed: ${res.status} ${snippet}`);
  }

  const json = (await res.json()) as {
    rows?: Array<{
      keys:        [string, string];
      clicks:      number;
      impressions: number;
    }>;
  };

  const rows: Array<{ date: string; query: string; impressions: number; clicks: number }> = [];
  for (const row of json.rows ?? []) {
    rows.push({
      date:        row.keys[0],
      query:       row.keys[1],
      impressions: row.impressions,
      clicks:      row.clicks,
    });
  }
  return rows;
}

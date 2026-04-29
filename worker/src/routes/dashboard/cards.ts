/**
 * Card registry for the Profound-style dashboard redesign (Phase A).
 *
 * Every card on the customer dashboard is defined ONCE in this file with
 * `{ id, label, description, fetch_endpoint, default_size, chart_kind }`.
 * The dashboard's `layout_json` references cards by id; adding a new card
 * type = one entry here + one renderer in clientScript.ts (the
 * `CARD_RENDERERS` map). Removing one is the inverse.
 *
 * Phase A ships 8 default cards. Phase B's "Add card" modal will list
 * every entry in this registry and let users append to their layout.
 *
 * Apr 29 2026.
 */

export type CardSize = "sm" | "md" | "lg" | "xl";
/** Heights are roughly: sm=160, md=240, lg=320, xl=420 — tweak in CSS. */

/** Chart kinds map to ECharts setOption shapes in clientScript.ts. */
export type ChartKind =
  | "kpi"           // big number + delta vs previous range
  | "line"          // time series
  | "donut"         // categorical share
  | "bar_horizontal"// top-N rank
  | "heatmap"       // 7×24 grid (dow × hour)
  | "table"         // tabular list (top queries, recent activity)
  | "stacked_bar"   // funnel-style stacked counts
  | "count_list";   // simple "N pages live" with link list

export interface CardDef {
  id:               string;
  label:            string;       // user-facing title
  description:      string;       // shown in the "Add card" modal
  /** Endpoint shape: '/analytics/:slug' or '/analytics/:slug/activity' or
   *  '/api/competitor-radar/:slug/share-of-voice/weekly'. The `:slug`
   *  placeholder is replaced client-side with the active business slug.
   *  Date-range params are appended automatically by clientScript. */
  fetch_endpoint:   string;
  /** Default grid span. Users can resize via the card config menu (Phase B+). */
  default_size:     CardSize;
  chart_kind:       ChartKind;
  /** When true, the card is only available to Pro+ tenants and is hidden
   *  for Base tier. Phase A renders all cards regardless; tier gating is
   *  enforced in Phase B's add-card UI. */
  pro_only?:        boolean;
}

export const CARD_REGISTRY: CardDef[] = [
  {
    id:             "visibilityScore",
    label:          "Visibility Score",
    description:    "Total AI-crawler queries with delta vs the previous period.",
    fetch_endpoint: "/analytics/:slug",
    default_size:   "sm",
    chart_kind:     "kpi",
  },
  {
    id:             "queriesOverTime",
    label:          "Queries Over Time",
    description:    "Daily AI-crawler hits across the selected date range.",
    fetch_endpoint: "/analytics/:slug",
    default_size:   "lg",
    chart_kind:     "line",
  },
  {
    id:             "botMix",
    label:          "Crawler Mix",
    description:    "Share of queries by AI crawler (Claude, GPT, Perplexity, Google, etc).",
    fetch_endpoint: "/analytics/:slug",
    default_size:   "md",
    chart_kind:     "donut",
  },
  {
    id:             "intentDistribution",
    label:          "Query Intent",
    description:    "Share of queries by extracted intent (search, comparison, booking, etc).",
    fetch_endpoint: "/analytics/:slug",
    default_size:   "md",
    chart_kind:     "donut",
  },
  {
    id:             "activityHeatmap",
    label:          "Activity Heatmap",
    description:    "When AI crawlers fetch your profile — day-of-week × hour grid.",
    fetch_endpoint: "/analytics/:slug",
    default_size:   "lg",
    chart_kind:     "heatmap",
  },
  {
    id:             "topQueries",
    label:          "Top Queries",
    description:    "The 10 most-asked questions in the selected window.",
    fetch_endpoint: "/analytics/:slug",
    default_size:   "md",
    chart_kind:     "table",
  },
  {
    id:             "clickRate",
    label:          "Referral Click-Through",
    description:    "Click rate (clicks ÷ queries) over the selected window.",
    fetch_endpoint: "/analytics/:slug",
    default_size:   "sm",
    chart_kind:     "kpi",
  },
  {
    id:             "agentReputation",
    label:          "Agent Reputation",
    description:    "Identified AI agents ranked by quality score and conversion rate.",
    fetch_endpoint: "/analytics/:slug/activity",
    default_size:   "md",
    chart_kind:     "bar_horizontal",
  },
  {
    id:             "competitorShareOfVoice",
    label:          "Competitor Share of Voice",
    description:    "% of Perplexity polls that cited your domain, weekly.",
    fetch_endpoint: "/api/competitor-radar/:slug/share-of-voice/weekly",
    default_size:   "lg",
    chart_kind:     "line",
    pro_only:       true,
  },
  {
    id:             "reservationFunnel",
    label:          "Reservation Funnel",
    description:    "Held → Confirmed → Expired counts for inbound MCP reservations.",
    fetch_endpoint: "/analytics/:slug/activity",
    default_size:   "md",
    chart_kind:     "stacked_bar",
  },
  {
    id:             "syntheticPagesCount",
    label:          "Synthetic Pages Live",
    description:    "Auto-generated landing pages indexable by AI search (intent × service × location).",
    fetch_endpoint: "/admin/businesses/:slug/synthetic-pages-summary",
    default_size:   "sm",
    chart_kind:     "count_list",
    pro_only:       true,
  },
  {
    id:             "comparisonPagesCount",
    label:          "Comparison Pages Live",
    description:    "Auto-generated head-to-head competitor comparison pages.",
    fetch_endpoint: "/admin/businesses/:slug/comparison-pages-summary",
    default_size:   "sm",
    chart_kind:     "count_list",
    pro_only:       true,
  },
];

/** The 8-card seed for a brand-new dashboard. Mirrors the visual hierarchy
 *  Profound's blog-post screenshots show: KPI tiles top, primary trend
 *  chart wide, then breakdowns + heatmap, then activity tables. */
export const DEFAULT_DASHBOARD_LAYOUT: Array<{ card_id: string; size: CardSize }> = [
  { card_id: "visibilityScore",         size: "sm" },
  { card_id: "clickRate",               size: "sm" },
  { card_id: "queriesOverTime",         size: "lg" },
  { card_id: "botMix",                  size: "md" },
  { card_id: "intentDistribution",      size: "md" },
  { card_id: "activityHeatmap",         size: "lg" },
  { card_id: "topQueries",              size: "md" },
  { card_id: "agentReputation",         size: "md" },
];

/** Resolve a card definition by id. Returns null when the id isn't in
 *  the registry — caller decides whether to drop it from the layout
 *  (silent prune) or render an error placeholder. */
export function getCard(id: string): CardDef | null {
  return CARD_REGISTRY.find((c) => c.id === id) ?? null;
}

/** Convert a CardSize to a CSS grid-column span. Grid is 4-col. */
export function sizeToSpan(size: CardSize): number {
  switch (size) {
    case "sm": return 1;
    case "md": return 2;
    case "lg": return 3;
    case "xl": return 4;
  }
}

/**
 * Static contract: dashboard pages MUST NOT reintroduce the jargon
 * we swept out in the May 2026 voice/copy audit (docs/voice.md).
 *
 * Why this test exists
 * --------------------
 * Six dashboard pages (Business Profile, Mentions, Traffic Impact,
 * Settings, Overview, Competitor Radar) were rewritten to drop
 * technical jargon — JSON field names, AI/SEO acronyms, internal
 * product terms — and replace it with plain-English copy a non-
 * technical small-business owner can read.
 *
 * Without a regression catcher, a future copy edit (or a rebase
 * conflict) could quietly revert the rewrites. This test pins the
 * specific phrases that were removed, file by file. If someone re-adds
 * a forbidden phrase to user-facing copy, the suite goes red.
 *
 * The forbidden list intentionally targets the EXACT user-facing
 * phrases that were rewritten — not every word in docs/voice.md.
 * Blanket-banning words like "crawler" or "JSON-LD" would false-
 * positive on legitimate uses (Install snippet contains JSON-LD as a
 * code keyword; identifier names like `queries_by_crawler` are not
 * user-facing). The phrase-level assertions stay precise.
 *
 * Mirror of the static-grep pattern from
 * worker/src/dashboardShells.test.ts and the contract tests landed in
 * PRs #249, #250, #251, #258, #263.
 */

/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Vitest cwd is the worker/ package root. Site assets live one up.
const SITE_DIR = "../site";

/**
 * Strip JavaScript comments (// line, /* block *\/) so the forbidden-
 * phrase assertions don't false-positive on engineer notes inside the
 * source files. Block comments often legitimately contain the very
 * jargon the sweep replaced (because they explain WHY the sweep
 * happened), and line comments mention internal terms freely. Only the
 * runtime-rendered strings should be subject to the voice rules.
 *
 * Doesn't try to be a full JS parser — we accept the tiny risk that a
 * literal like `"/* not a comment *\/"` in a template string gets
 * partially blanked. None of the swept files contain that pattern as
 * of 2026-05-23.
 */
function stripComments(src: string): string {
  // Block comments first (must be greedy across newlines, non-greedy
  // for the closing pair).
  let stripped = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // Then line comments. Per-line so we don't eat across newlines.
  stripped = stripped.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  return stripped;
}

/**
 * Map of dashboard page → forbidden user-facing phrases. Each phrase
 * is the EXACT string that was rewritten in the May 2026 sweep. Adding
 * a new forbidden phrase here = adding a regression test for one more
 * rewrite; no other test infra needed.
 */
const FORBIDDEN: Array<[string, string[]]> = [
  [
    "js/v2/profile.js",
    [
      "% cite rate",                       // → "% predicted to be named"
      "Per-engine rendering",              // → "By AI tool"
      "per-engine breakdown",              // → "breakdown by AI tool"
      "AI bot visits",                     // → "AI search engine visits"
      "Availability webhook URL",          // → "Booking-system notification URL"
      "internal Claude-judge harness",     // → "Claude judge"
      "Live citation polls",               // → "Real-world AI mentions"
    ],
  ],
  [
    "js/v2/mentions.js",
    [
      "server-side bot fetches",           // → "how often AI search engines ... fetched your page"
      "Breakdown by detected intent",      // → "Breakdown by what the person was looking for"
      "Advocate's agent classifies",       // → "Every question ... gets sorted into one of these groups"
      "How we categorize each query",      // → "How we sort each question into a group"
    ],
  ],
  [
    "js/v2/traffic-impact.js",
    [
      "per-source-class engagement",       // → "engagement by AI vs Human source"
      "tenant-wide; GA4 doesn",            // → "covers every visit. Google Analytics can't"
      "raw GA4 source / medium",           // → "raw Google Analytics sources"
      "in-app browsers that strip the referrer", // → "AI apps on phones ... don't carry source info"
      "per-event revenue attribution",     // → "real revenue per booking"
      "Verified-revenue webhook is configured",  // → "Verified-revenue connection is configured"
      "POSTs an event",                    // → "sends an event"
      "Latest webhook deliveries",         // → "Latest events"
      "AI Overview cite rate",             // → "Clicks from AI Overview"
      "Clicks per AI Overview impression", // → "Share of AI Overview shows that sent a click"
      "See LTV per acquisition source",    // → "See lifetime value per acquisition source"
      "AI-acquired vs unknown-source customer cohorts", // → "customers acquired through AI search vs unknown sources"
      "Track customer LTV by acquisition source",       // → "Track customer lifetime value (LTV) ..."
      "Aggregate roll-ups only",           // → "We only see totals"
      "Customer LTV by acquisition source",             // → "Customer lifetime value (LTV) ..."
      "first-touch attribution from your", // → "the source we first matched each contact to in your"
      "Attribution method: 24h time-window match", // → "How we link a sale to a source"
      "UTM threading from your checkout",  // → "source-tracking codes (UTM tags)"
      "deterministic attribution (future feature)",     // → "be more precise (coming soon)"
      "raw bot-citation counts",           // → "raw count of how often AI engines fetched your page"
    ],
  ],
  [
    "js/v2/settings.js",
    [
      "How AI crawlers reach your agent",  // → "How AI search engines find your business listing"
      "Last bot hit",                      // → "Last AI engine visit"
      "x-agent-identity",                  // → no longer surfaced in user copy
      "Programmatic access for your own code", // → "For developers integrating with Advocate"
      "Install / JSON-LD",                 // → "Install on your site"
      "search engines + AI crawlers pick up your Advocate profile", // → "search engines and AI tools pick up your Advocate listing"
      ">Connected agents<",                // → ">Connected AI tools<"
      "MCP agents calling your tools",     // → "AI tools calling your listing"
      "Tiers gate rate-limits",            // → "Tiers control how often each AI tool can call your listing"
      "track AI Overview presence rate and cite rate",  // → "track how often Google's AI Overview shows ..."
      "Track AI Overview presence and cite rate",       // → "Track how often Google's AI Overview shows ..."
      ">Verified-revenue webhook<",        // → ">Booking-system connection<"
      ">Webhook status<",                  // → ">Booking-system status<"
      "Configure the webhook for confirmed numbers",    // → "Connect your booking system for confirmed numbers"
    ],
  ],
  [
    "js/v2/overview.js",
    [
      "Confirmed via your booking-system webhook",  // → "Confirmed by your booking system"
      "Configure a revenue webhook in Settings",    // → "Connect your booking system in Settings"
      "Bookings AI agents made on your behalf via MCP", // → "via the AI plugin protocol (MCP)"
      "% of tracked competitor queries AI named you", // → "Out of every 100 times someone searches your category"
      "No crawler traffic yet",            // → "No AI search engine traffic yet"
      "Breakdown by crawler",              // → "Breakdown by AI search engine"
      "AI crawlers will populate this table", // → "This table fills in as AI search engines fetch your listing"
      "When an AI agent reaches your business via MCP", // → "through the AI plugin protocol (MCP)"
      "agent tool calls · ",               // → "AI tool requests · "
      "Agent call · ",                     // → "AI tool call · "
      "Activity appears as crawlers and agents arrive", // → "Activity appears as AI tools arrive"
      "Last 8 events across bots, agents, and reservations", // → "Last 8 events across AI tools and reservations"
      "% cite rate ",                      // → "% predicted to be named "
      "per-engine rendering each bot receives", // → "version of your page each AI tool actually sees"
      "Real citations from live polls",    // → "Real-world mentions from weekly tests"
      "computed from your supplied average ticket", // → "computed from your average ticket"
      "Configure a verified-revenue webhook", // → "Connect your booking system"
    ],
  ],
  [
    "js/v2/radar.js",
    [
      "Weekly polls — every relevant query",  // → "Weekly AI search tests — every relevant search"
      "Share of Model",                       // → "How often AI named you"
      ">Loss tracking<",                      // → ">Who's beating you<"
      "Keyword authority gaps",               // → "Topics where competitors are winning"
      "No per-bot breakdown yet",             // → "No per-AI-tool breakdown yet"
      "first weekly poll is still running",   // → "first weekly test is still running"
      ">Total polls<",                        // → ">Total AI search tests<"
      "Queries tested this week",             // → "Searches tested this week"
      ">Tracked queries<",                    // → ">Tracked searches<"
      "Authority gap we'd close first",       // → "Topic where competitors are winning most"
      "No authority gaps surfaced yet",       // → "No topic gaps surfaced yet"
      "Share of voice — weekly trend",        // → "How often AI named you — weekly trend"
      "% of polls where AI cited your domain", // → "Share of AI search tests where AI named your site"
      ">Query basket<",                       // → ">Tracked searches<"
      "The phrasings we poll weekly",         // → "The searches we test against AI weekly"
      "first poll runs Mon/Wed/Fri",          // → "first AI search test runs Mon/Wed/Fri"
    ],
  ],
];

describe("voice/copy audit: dashboard pages stay in plain English", () => {
  for (const [path, phrases] of FORBIDDEN) {
    describe(path, () => {
      const src = stripComments(readFileSync(`${SITE_DIR}/${path}`, "utf-8"));
      for (const phrase of phrases) {
        it(`does not contain forbidden phrase: ${JSON.stringify(phrase)}`, () => {
          expect(src).not.toContain(phrase);
        });
      }
    });
  }
});

describe("voice/copy audit: required anchors stay in place", () => {
  // The "In plain English:" banner is the established voice anchor on
  // each metric page. If any of these get dropped during a refactor,
  // the page reverts to opening with a wall of metrics — the exact UX
  // problem the sweep addressed.
  const PAGES_WITH_BANNER = [
    "js/v2/mentions.js",
    "js/v2/overview.js",
    "js/v2/profile.js",
    "js/v2/radar.js",
    "js/v2/traffic-impact.js",
  ];
  for (const p of PAGES_WITH_BANNER) {
    it(`${p} carries an "In plain English:" banner`, () => {
      const src = readFileSync(`${SITE_DIR}/${p}`, "utf-8");
      // The literal phrase appears inside a <strong> wrapper. Loose
      // match: the substring anywhere in the file. Tightening to the
      // exact <strong> shape risks false-failing on a refactor that
      // styles it differently.
      expect(src).toContain("In plain English:");
    });
  }
});

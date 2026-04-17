# State of AI Bot Traffic — Q1 2026 Methodology Preview

**Published Apr 17 2026**

By Cameron McEwan, Founder, Advocate
Contact: support@advocatemcp.com

---

## Executive Summary

Advocate is the first platform sitting on both the AI crawler path and the transaction path for small and medium businesses. We intercept bot requests at the edge, return a per-query response, and wrap every outbound citation in a cryptographically signed redirect so that the eventual human click is attributable back to the exact bot and exact query that produced the citation.

This is the methodology preview, not the quantitative report. The instrument has been running in production for a little over a week against three real tenants. In that window it logged 64 total bot queries and attributed six click events. Most of the queries are our own instrumentation probes — we quantify that here instead of burying it — and the surviving organic subset is too small to draw statistical conclusions from. What we can publish honestly:

> The instrument works. It just attributed its first organic AI-bot click at SMB tier. Everything else is Q2's job.

Q2 lands in July with a larger sample, vertical cuts, and the first quantitative cross-bot comparisons we'll stand behind.

---

## Why this report exists

There is a structural attribution gap in every AI-search stack shipping today.

Citation-monitoring platforms — [Scrunch](https://scrunchai.com/), [Profound](https://tryprofound.com/), [Peec](https://peec.ai/), [Otterly](https://otterly.ai/), [Athena HQ](https://athenahq.ai/) — answer one question: "am I being cited?" That is necessary but not sufficient. None of them can tell an SMB whether a citation in a Perplexity answer produced a booked appointment or a revenue dollar.

Traditional web analytics cannot fill the gap either. AI-referred traffic either arrives referrer-less (the user typed the URL out of the chat interface), or arrives with a referrer like `chat.openai.com` that tells you the surface but not the query, the bot, or the session. You cannot tie the visitor back to a specific answer the model quoted.

On the publisher side, [Reddit's AI licensing deals with OpenAI and Google](https://www.cjr.org/analysis/reddit-winning-ai-licensing-deals-openai-google-gemini-answers-rsl.php) have closed a version of this loop at the content-producer tier — Reddit reportedly receives ~$60M/year from Google for training data access. But there is no Reddit-equivalent for an independent plumber in Austin, a pediatric orthotic brand, or a regional real-estate brokerage. That is the gap this research program exists to fill.

This Q1 release is a methodology preview. Its job is to publish the instrument and its first readings so the industry can evaluate the approach before the quantitative data arrives in Q2.

---

## Methodology

### Data source
All data in this preview comes from Advocate's production systems covering April 8, 2026 — the first day a tenant received a live AI crawler request — through April 17, 2026.

### Sample
Three real business tenants were onboarded during this window:

- **DMRE** — commercial real-estate brokerage, Austin, TX
- **Workman Copy Co** — copywriting / marketing agency, US
- **Bamboo Brace** — direct-to-consumer pediatric medical device, US-based, international shipping

The production instrument logged **64 total bot queries** across these tenants plus three ephemeral test tenants used during build-out verification.

### Query classification

Before reporting any bot-share or conversion numbers we classify each query into one of three buckets:

| Class | Rule | Count |
|---|---|---|
| **BURST** | Same `(slug, bot, query)` triple within 10 minutes of another | 38 |
| **TEST_SLUG** | Query against `redirect-test-apr12`, `openai-reviewer-demo-business`, or `final-verify-1776377843` — build-out or review-demo tenants, not customer-facing | 6 |
| **REAL?** | Everything else — plausibly organic AI-crawler traffic | 20 |

38 of 64 queries (59%) are self-generated instrumentation traffic from build-out. Another 6 (9%) are against test tenants. The 20 surviving queries (31% of raw total) are the subset any honest analysis has to work from.

### Bot identification
Bots are identified by User-Agent at our edge. The match list is public in our manifest and includes:

`PerplexityBot`, `GPTBot`, `OAI-SearchBot`, `ClaudeBot`, `Google-Extended`, `Googlebot`, `anthropic-ai`, `cohere-ai`, `meta-externalagent`.

A matched bot is routed to our agent pipeline; everything else falls through to origin. Bot-detection results are used as routing signals only, never as authentication.

### Intent classification
Queries are classified server-side into one of six buckets — `best_top`, `emergency`, `affordable`, `specific_service`, `brand_direct`, `general` — by a deterministic heuristic. This is server-side inference, not user labeling.

### Attribution
Every citation link returned in a bot response is wrapped in a cryptographically signed redirect token resolved at our edge. When a human clicks the link, the click is logged against the originating bot query and issued a 302 to the destination. Tokens carry no user-identifiable data and are verified without a database round-trip.

### Caveats — unignorable

1. **Sample size.** Clean N is 20 queries. Nothing here is statistically conclusive. Everything we report is directional and invites disproof.
2. **Single-vertical skew in clicks.** Every attributed click came from one tenant (DMRE). Single-tenant findings do not generalize.
3. **Observation window.** Nine days. Crawler behavior varies week-to-week; we do not yet have the baseline to normalize.
4. **Small-tenant skew.** Three tenants across three verticals is not a representative slice of the SMB economy.

Q2 will materially improve all four.

---

## Finding 1 — Bot share on the clean subset

On the 20 queries classified as plausibly organic, three bots showed up. The distribution is:

| Bot | Clean queries | Share |
|-----|--------------:|------:|
| GPTBot (all versions) | 10 | 50.0% |
| PerplexityBot | 5 | 25.0% |
| ClaudeBot | 5 | 25.0% |
| **Total** | **20** | **100%** |

*`OAI-SearchBot`, `Google-Extended`, `Googlebot`, `anthropic-ai`, `cohere-ai`, and `meta-externalagent` each appeared zero times in the organic subset.*

For transparency, the **raw distribution including all 64 queries** (build-out probes + test-slug + real) looks quite different — GPTBot 56%, PerplexityBot 30%, ClaudeBot 8%, mcp-client 5%, unknown 2% — because the early build-out probe pattern heavily weighted GPTBot on `bamboo-brace` and `dmre`. That raw distribution is not a defensible read of real crawler behavior. The clean subset is.

**What the clean subset lets us say:** at Q1's sample scale, GPTBot shows up on SMB sites roughly twice as often as PerplexityBot or ClaudeBot, which show up at comparable rates. ClaudeBot's showing is unexpected to the extent anyone is publishing data on this; we had modeled it as a distant third.

**What it does not let us say:** anything about which bot produces more commercial value per hit. See Finding 2.

### Tenant concentration in the clean subset

| Tenant | Queries | Share |
|---|---:|---:|
| DMRE | 9 | 45% |
| Workman Copy Co | 9 | 45% |
| Bamboo Brace | 2 | 10% |

DMRE and WCC are balanced; Bamboo Brace's lower volume reflects a smaller surface area for AI crawlers to encounter at this stage, not a measurement bias.

---

## Finding 2 — First organic click attributed

Six click events were logged to `click_events` during the window. Three distinct queries received clicks. The breakdown:

| Query id | Class | Bot | Tenant | Query text | Read |
|---|---|---|---|---|---|
| 28 | BURST | PerplexityBot | DMRE | *"do you specialize in land brokerage in Austin"* | Inside a burst pattern with id 27; likely our probe |
| 30 | REAL? | PerplexityBot | DMRE | *"do you handle commercial land sales"* | Genuinely organic |
| 31 | REAL? | PerplexityBot | DMRE | *"final session 1 verification"* | Query text is a manual-test tell; not organic |

Taking the classification seriously, the instrument attributed **one unambiguously organic click** in Q1 — id=30, PerplexityBot on DMRE, April 10.

That is the honest headline for this report: the attribution loop closed end-to-end for the first time on April 10, 2026, in a production deployment, against a real business, driven by a real Perplexity answer. The instrument works. What it can measure about cross-bot conversion at scale remains Q2's question.

**Why no GPTBot clicks?** The clean subset has 10 GPTBot queries and zero attributed clicks. This is consistent with the emerging third-party picture of GPTBot as an indexing crawler whose output is cached inside ChatGPT (no click-through needed) while PerplexityBot is a routing crawler whose answers surface clickable citations. But with 10 and 5 queries respectively the sample is far too small to call this a finding. It's a testable hypothesis for Q2.

---

## Finding 3 — Intent distribution

Because the intent classifier is deterministic and operates per-query, it's worth reporting both the raw and the clean distributions — the gap between them is itself an observation.

### Clean subset (N=20, REAL? only)

| Intent bucket | Count | Share |
|---------------|------:|------:|
| `general` | 10 | 50.0% |
| `affordable` | 7 | 35.0% |
| `brand_direct` | 2 | 10.0% |
| `best_top` | 1 | 5.0% |
| `emergency` | 0 | 0.0% |
| `specific_service` | 0 | 0.0% |

### Raw (all 64 queries, for contrast)

| Intent bucket | Count | Share |
|---------------|------:|------:|
| `general` | 34 | 53.1% |
| `affordable` | 21 | 32.8% |
| `brand_direct` | 4 | 6.2% |
| `emergency` | 2 | 3.1% |
| `specific_service` | 2 | 3.1% |
| `best_top` | 1 | 1.6% |

The `general` + `affordable` dominance appears in both — 85% of clean queries, 86% of raw. AI crawlers hitting small-business sites in Q1 are overwhelmingly asking "what does this business do" and "how much does it cost," not "who's the best." That's the discovery + consideration funnel, not the decision funnel. It suggests AI crawlers at this stage of SMB exposure are in catalog-building mode rather than recommendation mode.

**One interesting non-finding:** `emergency` intent did appear twice in the raw data (plumber / HVAC-adjacent language) but both instances fell into BURST clusters and disappear from the clean subset. So we cannot yet corroborate the anecdotal "AI assistants are used for 2am burst-pipe queries" pattern from production data — Q2 with a home-services tenant cohort is where that gets tested.

---

## What Q2 will measure

The Q2 report lands in July 2026. The sample will be larger by roughly one to two orders of magnitude, and will include measurements that simply cannot be made at N=20.

1. **Cross-bot conversion deltas.** First meaningful comparison of PerplexityBot vs. GPTBot vs. ClaudeBot vs. Google-AI-Overview conversion rates at SMB tier, measured through the signed redirect loop. This is the quantitative test of the index-vs-route hypothesis from Finding 2.
2. **Per-agent attribution.** Our per-agent reputation rollup shipped in April 2026. Q2 is the first report where we can attribute outcomes to specific caller agents (Claude Desktop vs. Cursor vs. ChatGPT Apps vs. generic MCP client) over 7-day and 30-day windows.
3. **Competitor Radar cohort data.** Our weekly Perplexity-poll loop auto-seeds a query basket per Pro tenant and records whether the tenant's domain showed up. Q2 will include the first cohort-level read on which citation battles SMBs systematically win vs. lose.
4. **Vertical and regional variation.** Once tenants span more verticals and states, we can report on whether crawler pressure correlates with regional AI-adoption or tracks legacy SEO patterns.
5. **MCP-client-originated transactions.** With [over 10,000 public MCP servers in the registry as of April 2026](https://www.infoq.com/news/2026/04/mcp-registry-10000/), Claude Desktop and Cursor are the leading edge of a shift where a meaningful fraction of SMB queries arrive as MCP tool calls, not as user-agent-identified crawler requests. Q2 will report on that ratio for the first time.

---

## About Advocate

Advocate intercepts AI crawler traffic at the edge, generates per-bot per-query optimized responses, and tracks every resulting citation click end-to-end. We also expose all registered businesses through a central MCP server at `/mcp` so MCP-compatible clients like Claude Desktop and Cursor can query any tenant directly. The free **Business** tier covers agent hosting and attribution. **Pro** adds Competitor Radar (weekly Perplexity citation polling) and per-agent reputation analytics.

- **Web:** [advocatemcp.com](https://advocatemcp.com)
- **Contact:** [support@advocatemcp.com](mailto:support@advocatemcp.com)

Journalists and AI-platform partnerships leads: we will share a de-identified aggregate export on request so you can evaluate any claim against the underlying data.

---

## Methodology appendix

### Attribution
Every outbound link in a bot response is wrapped in a cryptographically signed redirect token resolved at our edge. When a human clicks the link, the click is logged against the originating bot query and the user is 302'd to the destination. Tokens carry no user-identifiable data and are verified without a database round-trip.

### Bot detection
User-agent matching at the edge against a curated list of AI crawlers. The match logic is intentionally boring — no TLS fingerprinting or IP-reputation lookups — because the cost of a false negative (real bot routed to origin) is small and the cost of a false positive (human routed into the bot pipeline) is large. Bot detection is a routing signal only, never an auth primitive.

### Click deduplication
Deduplication happens at query time, not write time. A click is unique within a 24-hour window by the tuple (token, client-IP prefix, user agent). We prefix-truncate the IP before hashing so we cannot reconstruct a full user IP from the logs.

### Intent classification
A small deterministic rule set over the lowercased query string returning one of six buckets. Not an LLM classifier — a heuristic we can audit and update without a deploy. Both the bucket label and the raw query are stored so historical rows can be re-classified when rules change.

### Query classification for this report
BURST, TEST_SLUG, and REAL? classifications were applied post-hoc to the production `queries` table for this report specifically, using the rules documented in the Methodology section. The classification logic is not (yet) a first-class piece of the production stack; Q2 will include it as a durable view alongside raw query data.

### Verification
Journalists, AI-platform partnerships teams, and research reviewers can request a methodology walk-through call at support@advocatemcp.com. We can demonstrate the pipeline end-to-end against a live tenant without disclosing proprietary implementation detail.

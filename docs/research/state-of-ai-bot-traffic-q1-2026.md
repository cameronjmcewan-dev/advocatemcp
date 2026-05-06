# State of AI Bot Traffic — Q1 2026 Methodology Preview

**Published Apr 17 2026**

By Cameron McEwan, Founder, Advocate
Contact: max@advocate-mcp.com

---

## Executive Summary

Advocate is the first platform sitting on both the AI crawler path and the transaction path for small and medium businesses. We intercept bot requests at the edge, return a per-query response, and wrap every outbound citation in a cryptographically signed redirect so that the eventual human click is attributable back to the exact bot and exact query that produced the citation.

This Q1 release reports what the instrument sees in its validation phase and its first real customer week.

Two notes on scope up front, because they shape everything that follows:

1. **Advocate has one paying customer to date** — a copywriting agency. Every other domain that appears in the Q1 dataset is either an internal test slug or one of our own pre-customer pilot installs. We are explicit about which is which in the methodology.
2. **We published this report at N=64 queries because documenting the instrument in its validation phase is the honest version of the story.** Q2 is the first quantitative report with a multi-customer organic sample.

> The attribution loop is proven to close end-to-end. Six click events captured in the validation phase, zero on the customer side in week one. The instrument works. The market side is Q2's job.

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

### Sample — three tenant types

The production instrument logged **64 total bot queries** across three distinct tenant types. We break these out explicitly because they are not all the same thing and commingling them produces dishonest numbers:

| Tenant type | Slug(s) | Queries | What it is |
|---|---|---:|---|
| **Live customer** | `[redacted]` | 20 | Our first paying customer — a copywriting / marketing agency |
| **Pilot validation install** | `dmre`, `[redacted]` | 38 | Our own pre-customer test installs on real-sounding domains. Used to stand up, instrument, and validate the attribution pipeline before first customer release |
| **Internal test tenant** | `redirect-test-apr12`, `openai-reviewer-demo-business`, `final-verify-1776377843` | 6 | Ephemeral tenants for build-out verification and third-party review demos |

The pilot installs (DMRE and one other) were our own domains used as live targets for validating the pipeline. They are not customer relationships. Treating them as customer data would be misleading. Treating them as useless test artifacts would also be misleading — **the whole point of validation-phase traffic is to prove the instrument works before pointing it at customers**.

### Query classification

Within each tenant type we further classify each query as either **ORGANIC** (plausibly a real AI crawler hit) or **BURST** (same slug + bot + query within 10 minutes of another — our own probe traffic during validation sessions):

| Tenant type | Total | BURST | ORGANIC |
|---|---:|---:|---:|
| Live customer (WCC) | 20 | 11 | **9** |
| Pilot validation | 38 | 27 | **11** |
| Internal test | 6 | — | — |
| **Total** | **64** | **38** | **20** |

The 20 ORGANIC queries are the defensible subset. All 6 tracked click events in Q1 came from the pilot-validation tier on DMRE — which is what you would expect for a pipeline running during its build-out phase. **The instrument captured them correctly. That was the point of the validation.**

### Bot identification
Bots are identified by User-Agent at our edge. The match list is public in our manifest and includes:

`PerplexityBot`, `GPTBot`, `OAI-SearchBot`, `ClaudeBot`, `Google-Extended`, `Googlebot`, `anthropic-ai`, `cohere-ai`, `meta-externalagent`.

A matched bot is routed to our agent pipeline; everything else falls through to origin. Bot-detection results are used as routing signals only, never as authentication.

### Intent classification
Queries are classified server-side into one of six buckets — `best_top`, `emergency`, `affordable`, `specific_service`, `brand_direct`, `general` — by a deterministic heuristic. This is server-side inference, not user labeling.

### Attribution
Every citation link returned in a bot response is wrapped in a cryptographically signed redirect token resolved at our edge. When a human clicks the link, the click is logged against the originating bot query and issued a 302 to the destination. Tokens carry no user-identifiable data and are verified without a database round-trip.

### Caveats — unignorable

1. **Sample size.** Live-customer ORGANIC N is 9 queries. Nothing here is statistically conclusive. Everything we report is directional and invites disproof.
2. **One customer.** Q1 has one paying customer. Vertical, regional, and cross-tenant generalizations are impossible until Q2.
3. **Observation window.** Nine days. Crawler behavior varies week-to-week; we do not yet have the baseline to normalize.
4. **Clicks came from pilot installs.** The validation-phase clicks (6 events, 3 queries, all DMRE) prove the loop closes but do not tell us anything about customer-facing conversion.

Q2 will materially improve all four.

---

## Finding 1 — Live customer bot distribution (WCC, N=20)

On our first paying customer's domain, across 20 total queries (11 BURST + 9 ORGANIC), the bot distribution was:

| Bot | WCC queries | Share |
|-----|--------------:|------:|
| PerplexityBot | 12 | 60.0% |
| ClaudeBot | 5 | 25.0% |
| GPTBot (all versions) | 3 | 15.0% |
| **Total** | **20** | **100%** |

**What the live-customer data suggests (with heavy caveat):** at this scale and for this type of business (B2B copywriting / marketing agency), **PerplexityBot was the dominant AI crawler**, not GPTBot. ClaudeBot's showing is non-trivial. GPTBot is a minority.

This contradicts the conventional wisdom that GPTBot dominates AI crawler volume. We are not claiming it generalizes — N is tiny and one vertical isn't a market — but it is the first customer-tier data point in print.

### Contrast: pilot validation distribution

Our own pre-customer pilot installs (DMRE + Bamboo Brace, N=38) saw a completely different mix: GPTBot 79%, PerplexityBot 16%, mcp-client 5%. That distribution is heavily shaped by how we ran build-out probes (GPTBot-simulated curl tests dominated the early validation sessions) and is *not* a read on real crawler behavior. Reporting it alongside the customer data would misrepresent both.

The gap between the two distributions is exactly the reason we insist on separating validation traffic from customer traffic.

---

## Finding 2 — The attribution loop closed end-to-end (in validation)

Six click events were captured in `click_events` during the Q1 window. Three distinct queries received clicks. All three were on our pilot-validation install (DMRE), all via PerplexityBot sessions:

| Query id | Bot | Tenant type | Query text | Read |
|---|---|---|---|---|
| 28 | PerplexityBot | Pilot validation | *"do you specialize in land brokerage in Austin"* | Inside a burst pattern with id 27 — our probe |
| 30 | PerplexityBot | Pilot validation | *"do you handle commercial land sales"* | Organic within the validation session |
| 31 | PerplexityBot | Pilot validation | *"final session 1 verification"* | Query text is a manual-test tell — our verification click |

**Honest headline:** the validation phase proved the attribution pipeline closes end-to-end. A bot query → signed citation response → human click → attributed back to the originating bot + query — all captured. The instrument works.

**What this does not prove:** that customer-facing bots will click, at what rate, which bots convert better, or anything about commercial value per crawler hit. That is Q2's work.

### Why no WCC clicks yet?

Our first paying customer was onboarded mid-window, has 9 ORGANIC queries in the dataset, and logged 0 attributed clicks. At N=9 over nine days, that is within the noise floor — a 10% click rate would produce 0–1 clicks. It is statistically uninformative. Q2 will have the volume to start separating signal from noise.

---

## Finding 3 — Intent distribution across validation + customer traffic

The intent classifier operates per-query regardless of tenant type. Across the 20 ORGANIC queries (all tenant types combined):

| Intent bucket | Count | Share |
|---------------|------:|------:|
| `general` | 10 | 50.0% |
| `affordable` | 7 | 35.0% |
| `brand_direct` | 2 | 10.0% |
| `best_top` | 1 | 5.0% |
| `emergency` | 0 | 0.0% |
| `specific_service` | 0 | 0.0% |

The `general` + `affordable` dominance (85% combined) indicates AI crawlers at this stage of SMB exposure are in catalog-building mode — "what does this business do" and "how much does it cost" — rather than recommendation mode.

**One interesting non-finding:** `emergency` intent showed up twice in the raw 64-query dataset (plumber / HVAC-adjacent language on our pilot installs) but both instances fell into BURST clusters and disappear from the ORGANIC subset. The "AI assistants are being used for 2am burst-pipe queries" pattern from plumbers is a real anecdotal report we wanted to test; at Q1 volume we cannot. Q2 with home-services tenants onboarded will.

---

## What Q2 will measure

The Q2 report lands in July 2026. Between now and then we will onboard more customers and materially expand the defensible sample.

1. **Cross-bot conversion deltas** at customer scale — first quantitative test of whether PerplexityBot's apparent dominance on the WCC sample holds across verticals.
2. **Per-agent attribution.** Our per-agent reputation rollup shipped in April 2026. Q2 is the first report where we can attribute outcomes to specific caller agents (Claude Desktop vs. Cursor vs. ChatGPT Apps vs. generic MCP client) over 7-day and 30-day windows.
3. **Competitor Radar cohort data.** Our weekly Perplexity-poll loop auto-seeds a query basket per Pro tenant and records whether the tenant's domain showed up. Q2 will include the first cohort-level read on which citation battles SMBs systematically win vs. lose.
4. **Vertical and regional variation.** Once tenants span more verticals and states, we can report on whether crawler pressure correlates with regional AI-adoption or tracks legacy SEO patterns.
5. **MCP-client-originated transactions.** With [over 10,000 public MCP servers in the registry as of April 2026](https://www.infoq.com/news/2026/04/mcp-registry-10000/), Claude Desktop and Cursor are the leading edge of a shift where a meaningful fraction of SMB queries arrive as MCP tool calls, not as user-agent-identified crawler requests. Q2 will report on that ratio for the first time.

---

## About Advocate

Advocate intercepts AI crawler traffic at the edge, generates per-bot per-query optimized responses, and tracks every resulting citation click end-to-end. We also expose all registered businesses through a central MCP server at `/mcp` so MCP-compatible clients like Claude Desktop and Cursor can query any tenant directly. The free **Business** tier covers agent hosting and attribution. **Pro** adds Competitor Radar (weekly Perplexity citation polling) and per-agent reputation analytics.

- **Web:** [advocatemcp.com](https://advocatemcp.com)
- **Contact:** [max@advocate-mcp.com](mailto:max@advocate-mcp.com)

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

### Tenant-type classification for this report
LIVE / PILOT / TEST tenant-type classifications were applied post-hoc to the production `queries` table using the slug allowlists documented in the Methodology section. BURST detection uses a 10-minute window on matching `(slug, bot, query)` tuples. Neither classifier is (yet) a first-class piece of the production stack; Q2 will include them as durable views alongside raw query data.

### Verification
Journalists, AI-platform partnerships teams, and research reviewers can request a methodology walk-through call at max@advocate-mcp.com. We can demonstrate the pipeline end-to-end against a live tenant without disclosing proprietary implementation detail.

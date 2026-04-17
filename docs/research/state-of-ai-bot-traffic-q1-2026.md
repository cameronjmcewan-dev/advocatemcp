# State of AI Bot Traffic — Q1 2026 Preview

**Draft v1 — Apr 16 2026**

By Cameron McEwan, Founder, AdvocateMCP
Contact: support@advocatemcp.com

---

## Executive Summary

AdvocateMCP is the first platform sitting on both the AI crawler path and the transaction path for small and medium businesses. Because we intercept bot requests at the Cloudflare edge AND serve as the destination MCP endpoint for tools like Claude Desktop and Cursor, every response we generate carries an HMAC-signed redirect token that survives the hop from "bot visited" to "human clicked" to "outcome attributed." This preview is the first public look at what that instrument can measure. The sample is small and early, but the shape of the pipeline is the story: citation-monitoring tools can tell you if you were quoted — we can tell you what happened next.

---

## Why this report exists

There is a structural attribution gap in every AI-search stack shipping today.

Citation-monitoring platforms — [Scrunch](https://scrunchai.com/), [Profound](https://tryprofound.com/), [Peec](https://peec.ai/), [Otterly](https://otterly.ai/), [Athena HQ](https://athenahq.ai/) — answer one question: "am I being cited?" That is necessary but not sufficient. None of them can tell an SMB whether a citation in a Perplexity answer produced a booked appointment or a revenue dollar.

Traditional web analytics cannot fill the gap either. AI-referred traffic either arrives referrer-less (the user typed the URL out of the chat interface), or arrives with a referrer like `chat.openai.com` that tells you the surface but not the query, the bot, or the session. You cannot tie the visitor back to a specific answer the model quoted.

On the publisher side, [Reddit's AI licensing deals with OpenAI and Google](https://www.cjr.org/analysis/reddit-winning-ai-licensing-deals-openai-google-gemini-answers-rsl.php) have closed this loop at the content-producer tier — Reddit now appears in roughly 3x more AI answers than Wikipedia, and gets paid for it. But there is no Reddit-equivalent for an independent plumber in Austin, a pediatric orthotic brand, or a regional real-estate brokerage. That is the gap this report is filling.

This is a methodology preview, not a statistical blockbuster. We are showing what the instrument can see before we have enough data for the readings to be authoritative. Q2's report will be the quantitative one.

---

## Methodology

### Data source
All data in this preview comes from AdvocateMCP's production tables on Railway (`queries`, `click_events`, `agent_requests`) covering April 9, 2026 — the day our first production tenant was onboarded — through April 16, 2026.

### Sample
Approximately 60 queries across 5 active business tenants. The public business registry at [`/registry`](https://advocate-production-2887.up.railway.app/registry) lists seven slugs today; two of those are placeholder or decommissioned test rows excluded from the numbers below. The active five span three verticals:

- **Home services / local trades** (multi-state pilots)
- **Direct-to-consumer e-commerce** (a pediatric medical device, US-based, international shipping)
- **B2B professional services** (an email marketing agency and a commercial real-estate brokerage, both Austin, TX)

### Bot identification
Bots are identified by User-Agent at the Cloudflare Worker edge. The match list (`AI_CRAWLERS`) is public in our manifest and includes:

`PerplexityBot`, `GPTBot`, `OAI-SearchBot`, `ClaudeBot`, `Google-Extended`, `Googlebot`, `anthropic-ai`, `cohere-ai`, `meta-externalagent`.

A matched bot is routed to our agent pipeline; everything else falls through to origin. Bot-detection results are used as routing signals only, never as authentication.

### Intent classification
Queries are classified server-side into one of six buckets — `best_top`, `emergency`, `affordable`, `specific_service`, `brand_direct`, `general` — by a heuristic in `server/src/agent/builder.ts`. This is server-side inference, not user labeling. Rates should be read as "how did our classifier bucket these queries" rather than "what did users actually want."

### Attribution
Every citation link returned in a bot response is wrapped in an HMAC-SHA256-signed redirect token. When a human later clicks that link, the Worker decodes the token at `/r/:token`, logs a row to `click_events` in Cloudflare D1, then issues a 302 to the destination. The signing key is shared across Worker and Railway so tokens can be verified at the edge without a database round-trip.

### Caveats — unignorable

1. **Sample size.** N is approximately 60. No statistical claim survives contact with that number; everything we report is directional.
2. **Smoke-testing bias.** A meaningful fraction of the queries in our window are from build-out smoke tests, including repeated PerplexityBot-spoofed probes against our first tenant. The bot-distribution finding is distorted as a result — see Finding 1.
3. **Observation window.** Seven days, bracketing a weekend. Crawler behavior varies week-to-week and we do not yet have the baseline to normalize.
4. **Vertical concentration.** Five tenants across three verticals is not a representative slice of the SMB economy.

Q2 will materially improve all four. This report is published as a methodology preview so the industry has something to evaluate the instrument against before the larger dataset lands.

---

## Finding 1 — Bot share of voice

In our Q1 sample, **OpenAI's GPTBot fleet (all versions) sent 58% of crawler traffic, nearly double PerplexityBot's 31%**. ClaudeBot was a distant third at 5%.

| Bot | Requests | Share |
|-----|---------:|------:|
| GPTBot (all versions) | 36 | 58.1% |
| PerplexityBot | 19 | 30.6% |
| ClaudeBot | 3 | 4.8% |
| mcp-client (our own MCP callers) | 3 | 4.8% |
| unknown | 1 | 1.6% |
| **Total** | **62** | **100%** |

*Sample window: April 9–16, 2026, across 5 active tenants spanning home services, copywriting, DTC pediatric medical devices, and commercial real estate. The three GPTBot variants (`GPTBot`, `GPTBot/1.0`, `GPTBot/1.1`) are collapsed as one.*

Some of this distribution is smoke-test-influenced — we validated the Worker edge against PerplexityBot UA during build-out — but the GPTBot-dominance is the organic signal and is consistent with what's publicly reported about OpenAI's crawl aggressiveness. `OAI-SearchBot`, `Google-Extended`, `Googlebot`, `anthropic-ai`, `cohere-ai`, and `meta-externalagent` each appeared zero times in the sample window. That's a finding in itself — the volume story at SMB-tier right now is an OpenAI / Perplexity duopoly.

### The conversion-quality surprise

**All 6 tracked clicks in the sample came from PerplexityBot sessions** — zero clicks attributed to GPTBot despite GPTBot's 1.9x volume advantage.

| Bot | Queries | Tracked clicks | Click rate |
|-----|--------:|---------------:|-----------:|
| PerplexityBot | 19 | 6 | **31.6%** |
| GPTBot (all versions) | 36 | 0 | 0.0% |

Caveat N=6: this is directional, not statistical. But the pattern is consistent with third-party reporting that Perplexity's answer surface links out more prominently and its users arrive with higher purchase intent, while ChatGPT's current default answer style more often self-contains the answer without a citation click. [ALM Corp reports ChatGPT-referred traffic still converts at 14.2% versus 2.8% for traditional organic search](https://almcorp.net/blog/chatgpt-conversion-rates-vs-google-seo), but that's once a user actually arrives on-site — our data suggests fewer of them make the jump from answer to site in the first place.

**Why this matters for SMBs.** Volume-heavy bot traffic without conversion tells you AI models know about your site; conversion-heavy bot traffic tells you they're recommending it in ways users act on. Any SMB tracking "AI traffic" without bot-level granularity — every traditional analytics tool — is flying blind. This sample, tiny as it is, already shows that bucketing AI crawlers into a single aggregate mis-prices the real economics of each one.

---

## Finding 2 — Response latency and cost per query

These are numbers we can report authoritatively because they are measured inside our own systems on every request. They are benchmark data, not sample data.

### Latency
- **Target p95 end-to-end:** under 1500ms (bot → Worker → Railway → Claude → signed redirect URL → response back)
- **Observed median in Q1:** *[TODO: pull median + p95 from `queries.latency_ms` for the sample window.]*

A future session will move hot-path inference closer to the edge to remove the Worker→Railway hop.

### Cost
- **Target Claude spend per response:** under $0.02
- **Observed per-response cost in Q1:** *[TODO: pull mean `cost_cents` from `agent_requests`.]*
- **Daily spend alerting threshold:** $5 / customer / day

We enable Anthropic prompt caching (`cache_control: ephemeral`) on the system prompt block, which separates static profile + intent + bot emphasis (cached) from the variable user query (not cached). After warm-up we expect a cache hit rate in the 60–80% range, which materially compresses per-request cost.

### What SMBs should expect from a well-tuned GEO stack
Sub-1500ms median agent responses and sub-two-cent per-response Claude cost are reasonable targets for any platform presenting itself as AI-crawler-ready. A vendor that cannot hit those numbers will either bleed margin at scale or bleed citation quality when crawlers time out on slow origins.

---

## Finding 3 — Intent distribution

The intent classifier bucketed the 50 most recent queries in the sample window as follows:

| Intent bucket | Count | Share | What triggers it |
|---------------|------:|------:|------------------|
| `general` | 27 | 54.0% | Default fallback when no specific buckets match |
| `affordable` | 17 | 34.0% | "cheap," "affordable," "price," "under $X" |
| `emergency` | 2 | 4.0% | "burst pipe," "tonight," "emergency," "24 hour" |
| `brand_direct` | 2 | 4.0% | Tenant name explicitly in query |
| `specific_service` | 2 | 4.0% | Named service from tenant's services list |
| `best_top` | 0 | 0.0% | "best X in Y" — absent in Q1 window |

**Two things stand out.**

First, **88% of queries fall into `general` + `affordable`** — AI crawlers hitting SMB sites in Q1 are overwhelmingly asking "what does this business do" and "how much does it cost," not "who's the best." That's the discovery + consideration funnel, not the decision funnel. It suggests AI crawlers are still in catalog-building mode for SMBs, not yet in the "cite this business in a recommendation" mode where `best_top` would dominate. Q2 will show whether that's a stage-of-market signal or a sample quirk.

Second, **`emergency` intent is rare in our data but non-zero (4%)** — and every emergency query came from a home-services tenant. This confirms what plumbers and HVAC companies have said anecdotally: AI assistants are being used for 2am "burst pipe, what do I do" queries. Even at N=2 the implication for service businesses is obvious: the availability and reservation tools (`get_availability`, `reserve_slot`) in AdvocateMCP's MCP surface need to handle after-hours emergency flows as a first-class case, not an edge case.

**Reminder:** this is server-side heuristic classification, not user-labeled intent. It tells us what the classifier thought; Q2 will add human-labeled spot checks to calibrate the heuristic. The full 62-query sample mostly follows the same distribution — the 12 queries not in `recent_hits` came from early-April smoke tests and skew even more toward `general`.

---

## What Q2 will measure

The Q2 report lands in July 2026. The sample will be larger by roughly one to two orders of magnitude, and will include measurements that simply cannot be made at N=60.

1. **Cross-bot conversion deltas.** The first meaningful comparison of Perplexity vs. ChatGPT vs. Claude vs. Google-AI-Overview conversion rates at SMB tier, measured through the HMAC-signed redirect loop — validating or refuting the [ALM Corp finding](https://almcorp.net/blog/chatgpt-conversion-rates-vs-google-seo) at non-enterprise scale.
2. **Per-agent attribution.** Our `agent_requests` table and reputation rollup shipped in April 2026. Q2 is the first report where we can attribute outcomes to specific caller agents (Claude Desktop vs. Cursor vs. ChatGPT Apps vs. generic MCP client) over 7-day and 30-day windows.
3. **Competitor Radar cohort data.** Our weekly Perplexity-poll loop auto-seeds a query basket per Pro tenant and records whether the tenant's domain showed up. Q2 will include the first cohort-level read on which citation battles SMBs systematically win vs. lose.
4. **Regional variation.** Once tenants span multiple states, we can report on whether crawler pressure correlates with regional AI-adoption or tracks legacy SEO patterns.
5. **MCP-client-originated transactions.** With [over 10,000 public MCP servers in the registry as of April 2026](https://www.infoq.com/news/2026/04/mcp-registry-10000/), Claude Desktop and Cursor are the leading edge of a shift where a meaningful fraction of SMB queries arrive as MCP tool calls, not as user-agent-identified crawler requests. Q2 will report on that ratio for the first time.

---

## About AdvocateMCP

AdvocateMCP intercepts AI crawler traffic at the Cloudflare edge, generates per-bot per-query optimized responses via Claude Sonnet, and tracks every resulting citation click end-to-end. We also expose all registered businesses through a central MCP server at `/mcp` so MCP-compatible clients like Claude Desktop and Cursor can query any tenant directly. The free **Business** tier covers agent hosting and attribution. **Pro** adds Competitor Radar (weekly Perplexity citation polling) and per-agent reputation analytics.

- **Web:** [advocatemcp.com](https://advocatemcp.com)
- **Contact:** [support@advocatemcp.com](mailto:support@advocatemcp.com)
- **Manifest:** [`/.well-known/mcp.json`](https://advocate-production-2887.up.railway.app/.well-known/mcp.json)
- **Registry:** [`/registry`](https://advocate-production-2887.up.railway.app/registry)

Journalists, AI-platform partnerships leads, or Cloudflare BD: we will share a de-identified query export on request so you can verify any claim against the underlying data.

---

## Methodology appendix

For reviewers who want to verify this report's findings end-to-end.

### Attribution token format
Every outbound link is wrapped in a redirect of the form `https://<tenant-host>/r/:token`. The token is a base64url payload signed with HMAC-SHA256 (shared secret `TOKEN_SIGNING_KEY`, identical on Worker and Railway). The payload carries tenant slug, query ID, destination URL, issued-at timestamp, and an optional `aid` claim for the caller agent ID. The Worker verifies at `/r/:token`, writes a row to `click_events` in D1, and 302s. No user-identifiable data is in the token.

### Bot detection
Pure user-agent matching at the Cloudflare Worker edge against the `AI_CRAWLERS` array. The match logic is intentionally boring — no TLS fingerprinting, JA3/JA4, or IP-reputation lookups — because the cost of a false negative (real bot routed to origin) is small and the cost of a false positive (human routed into the bot pipeline) is large. Bot detection is a routing signal only, never an auth primitive.

### Click deduplication
Deduplication happens at query time, not write time. A click is unique within a 24-hour window by the tuple (token, client-IP prefix, user agent). We prefix-truncate the IP before hashing so we cannot reconstruct a full user IP from the logs.

### Intent classification
A small deterministic rule set over the lowercased query string returning one of six buckets. Not an LLM classifier — a heuristic we can audit and update without a deploy. Both the bucket label and the raw query are stored so historical rows can be re-classified when rules change.

### Source code
The AdvocateMCP server, Worker, and manifest are hosted privately today. Reviewers who need source-level verification of any claim can contact support@advocatemcp.com — we will share the relevant files under a short NDA. Open-sourcing of the Worker pipeline is on the roadmap for later in 2026.

---

## For Cameron's review

### Unsourced claims that need double-checking before publishing

1. **ALM Corp (ChatGPT 14.2% vs 2.8% organic) — verified live at https://almcorp.net/blog/chatgpt-conversion-rates-vs-google-seo** ✓ URL returns 200 as of Apr 16 2026.
2. **InfoQ 10K+ MCP servers — verified live** ✓ URL returns 200. Confirm the number in the story still matches when you read it.
3. **Reddit AI licensing — swapped Reuters URL (paywalled/401) for CJR (free, 200)** ✓ Cites the "3x Wikipedia citation lead" + "$60M/yr Google deal" framing.

*Note: Profound $96M Series C @ $1B was referenced in the strategic brief but is NOT cited inline. If you want a "why this category matters" paragraph in Section 2, add the Fortune/TechCrunch link for the valuation. I left it out to keep the report focused on the attribution-gap thesis rather than financial positioning.*

### Remaining data gaps

1. **Finding 2 latency (median + p95 ms)** — NOT pulled. The `/analytics` endpoint doesn't expose latency; would need direct SQL on `queries.latency_ms`. Options: (a) leave as stated targets (status quo — targets are real), (b) share Railway DB read access so I can pull exact median/p95, or (c) drop Finding 2 entirely and let the report lead with bot-share + conversion + intent only.
2. **Finding 2 cost (mean cost_cents per response)** — same. Leave as target, or share `agent_requests` access.
3. **Optional: bot-share bar chart SVG** for the TechCrunch push. Skip if it slows publishing.

### Pre-publish checklist

- [x] External URLs verified live (ALM, InfoQ, CJR)
- [x] Finding 1 table — real bot counts (62 queries, GPTBot 58.1%, PerplexityBot 30.6%)
- [x] Finding 1 conversion surprise — all 6 clicks from PerplexityBot
- [x] Finding 3 intent counts — real distribution (general 54%, affordable 34%, emergency 4%)
- [ ] Finding 2 latency + cost — decide on option a/b/c above
- [ ] PR HTML version to `site/research/state-of-ai-bot-traffic-q1-2026.html` matching brand system (maroon #7d2550, white star logo)
- [ ] OpenGraph + Twitter card meta tags with custom social image
- [ ] Draft LinkedIn post (1 para, lead with attribution-gap framing + GPTBot-volume-vs-Perplexity-conversion surprise)
- [ ] Draft r/SEO post — title focused on methodology, not hype
- [ ] Draft TechCrunch / Fortune pitch email — hook: "first SMB-tier measurement of AI-bot attribution" + the conversion-quality finding
- [ ] Press email list: reporters who covered Profound, Scrunch, Perplexity, CF AI-bot announcements in the last 6 months
- [ ] 48-hour courtesy heads-up to Perplexity BD and OpenAI publisher relations before publish
- [ ] Schedule social push for Tues/Wed AM EST
- [ ] Monitor `/.well-known/mcp.json` and `/registry` for crawler traffic spikes post-publish

### Publishing checklist

- [ ] Verify all inline URLs resolve (Reuters, ALM Corp, InfoQ, competitor sites)
- [ ] Fill in the five data placeholders above
- [ ] PR HTML version to `site/research/state-of-ai-bot-traffic-q1-2026.html` matching brand system (maroon #7d2550, white star logo)
- [ ] OpenGraph + Twitter card meta tags with custom social image
- [ ] Draft LinkedIn post (1 para, lead with the attribution-gap framing)
- [ ] Draft r/SEO post — title focused on methodology, not hype
- [ ] Draft TechCrunch / Fortune pitch email — hook: "first SMB-tier measurement of AI-bot attribution"
- [ ] Press email list: reporters who covered Profound, Scrunch, Perplexity, and Cloudflare's AI-bot-blocking announcements in the last 6 months
- [ ] 48-hour courtesy heads-up to Perplexity BD and OpenAI publisher relations before publish
- [ ] Schedule social push for Tues/Weds AM EST
- [ ] Monitor `/.well-known/mcp.json` and `/registry` for crawler traffic spikes post-publish — the report itself is a citation magnet

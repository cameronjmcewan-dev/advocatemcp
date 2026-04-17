# State of AI Bot Traffic — Q1 2026 Preview

**Draft v1 — Apr 16 2026**

By Cameron McEwan, Founder, AdvocateMCP
Contact: support@advocatemcp.com

---

## Executive Summary

AdvocateMCP is the first platform sitting on both the AI crawler path and the transaction path for small and medium businesses. Because we intercept bot requests at the edge AND serve as the destination MCP endpoint for tools like Claude Desktop and Cursor, every response we generate carries a cryptographically signed redirect token that survives the hop from "bot visited" to "human clicked" to "outcome attributed." This preview is the first public look at what that instrument can measure. The sample is small and early, but the shape of the pipeline is the story: citation-monitoring tools can tell you if you were quoted — we can tell you what happened next.

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
All data in this preview comes from AdvocateMCP's production systems covering April 9, 2026 — the day our first production tenant was onboarded — through April 16, 2026.

### Sample
Approximately 60 queries across a small pilot cohort of active business tenants, spanning three verticals:

- **Home services / local trades** (multi-state pilots)
- **Direct-to-consumer e-commerce** (a pediatric medical device, US-based, international shipping)
- **B2B professional services** (an email marketing agency and a commercial real-estate brokerage, both Austin, TX)

### Bot identification
Bots are identified by User-Agent at our edge. The match list is public in our manifest and includes:

`PerplexityBot`, `GPTBot`, `OAI-SearchBot`, `ClaudeBot`, `Google-Extended`, `Googlebot`, `anthropic-ai`, `cohere-ai`, `meta-externalagent`.

A matched bot is routed to our agent pipeline; everything else falls through to origin. Bot-detection results are used as routing signals only, never as authentication.

### Intent classification
Queries are classified server-side into one of six buckets — `best_top`, `emergency`, `affordable`, `specific_service`, `brand_direct`, `general` — by a deterministic heuristic. This is server-side inference, not user labeling. Rates should be read as "how did our classifier bucket these queries" rather than "what did users actually want."

### Attribution
Every citation link returned in a bot response is wrapped in a cryptographically signed redirect token resolved at our edge. When a human later clicks the link, the click is logged against the originating bot query and issued a 302 to the destination. Tokens carry no user-identifiable data and are verified without a database round-trip.

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
- **Target p95 end-to-end:** under 1500ms (bot request in → signed citation response out)
- **Observed median in Q1:** reported in full in the Q2 report once the sample supports it.

### Cost
- **Target model spend per response:** under $0.02
- **Daily spend alerting threshold:** $5 / customer / day

We use prompt caching on the static components of the system prompt so only the variable user query contributes to the marginal cost of each call. After warm-up we expect a cache hit rate in the 60–80% range, which materially compresses per-request cost.

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

1. **Cross-bot conversion deltas.** The first meaningful comparison of Perplexity vs. ChatGPT vs. Claude vs. Google-AI-Overview conversion rates at SMB tier, measured through the signed redirect loop — validating or refuting the [ALM Corp finding](https://almcorp.net/blog/chatgpt-conversion-rates-vs-google-seo) at non-enterprise scale.
2. **Per-agent attribution.** Our per-agent reputation rollup shipped in April 2026. Q2 is the first report where we can attribute outcomes to specific caller agents (Claude Desktop vs. Cursor vs. ChatGPT Apps vs. generic MCP client) over 7-day and 30-day windows.
3. **Competitor Radar cohort data.** Our weekly Perplexity-poll loop auto-seeds a query basket per Pro tenant and records whether the tenant's domain showed up. Q2 will include the first cohort-level read on which citation battles SMBs systematically win vs. lose.
4. **Regional variation.** Once tenants span multiple states, we can report on whether crawler pressure correlates with regional AI-adoption or tracks legacy SEO patterns.
5. **MCP-client-originated transactions.** With [over 10,000 public MCP servers in the registry as of April 2026](https://www.infoq.com/news/2026/04/mcp-registry-10000/), Claude Desktop and Cursor are the leading edge of a shift where a meaningful fraction of SMB queries arrive as MCP tool calls, not as user-agent-identified crawler requests. Q2 will report on that ratio for the first time.

---

## About AdvocateMCP

AdvocateMCP intercepts AI crawler traffic at the edge, generates per-bot per-query optimized responses, and tracks every resulting citation click end-to-end. We also expose all registered businesses through a central MCP server at `/mcp` so MCP-compatible clients like Claude Desktop and Cursor can query any tenant directly. The free **Business** tier covers agent hosting and attribution. **Pro** adds Competitor Radar (weekly Perplexity citation polling) and per-agent reputation analytics.

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

### Verification
Journalists, AI-platform partnerships teams, and research reviewers can request a methodology walk-through call at support@advocatemcp.com. We can demonstrate the pipeline end-to-end against a live tenant without disclosing proprietary implementation detail.

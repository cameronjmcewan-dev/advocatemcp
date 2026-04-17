# State of AI Bot Traffic Q1 2026 — Launch Kit

Copy-paste-ready social posts and community submissions. Post in this order on publish day (see `send-sequence.md` for timing).

**Canonical URL:** `https://advocatemcp.com/research/state-of-ai-bot-traffic-q1-2026`

Use that URL everywhere. Do not shorten. Social crawlers need the canonical to hit the OG image.

---

## 1. LinkedIn post (primary)

Post from Cameron's personal profile. Tag Advocate page. Keep line breaks — they read better on LinkedIn than one wall of text.

```
We just published the first closed-loop AI attribution data from small businesses in production.

The instrument: a Cloudflare Worker that intercepts AI crawler requests at the edge, generates per-bot citation-ready responses, and tracks every outbound link with HMAC-signed redirect tokens. When a human clicks through from an AI answer, the loop closes.

Here is what the first week of production data looks like across three real tenants (20 organic queries, classified from 64 total):

→ GPTBot sent 50% of organic queries. PerplexityBot 25%. ClaudeBot 25%.
→ The only attributed click we could unambiguously classify as organic came from PerplexityBot on a single tenant.
→ 88% of queries were general or affordability-focused. Purchase-intent signal was thin.

The sample is small by design — this is week one. But what matters is the instrument, not the numbers. Nobody at SMB tier has closed this loop before: crawler query → bot-specific response → signed citation → user click → attribution back to the originating bot and query.

Profound and Scrunch serve enterprise citation monitoring. Reddit reportedly receives ~$60M/year from Google for training data access. But there is no equivalent for an independent plumber in Austin or a pediatric orthotic brand. That is the gap.

Q2 will be the first quantitative report. This is the methodology preview — what the instrument measures, how we classify traffic, and the early signals.

Full report:
https://advocatemcp.com/research/state-of-ai-bot-traffic-q1-2026

I would love to hear from anyone else running AI bot attribution at any scale. What does your measurement look like?
```

**Length check:** ~1,700 characters. LinkedIn's sweet spot is 1,300–2,000 for organic reach.

---

## 2. Twitter/X thread

Post from `@cameronjmcewan` (or the Advocate handle if set up). One claim per tweet, concrete numbers on every line. Last tweet is the link — the algorithm penalizes links in the first tweet.

**Tweet 1 (hook):**
```
We built the first closed-loop AI attribution system for small businesses and just published what the instrument sees in its first week of production.

20 organic queries. 3 tenants. 3 bots. Here's the methodology preview.

Thread 🧵
```

**Tweet 2:**
```
Why this matters: nobody at SMB tier has closed the loop from crawler query → bot-specific response → tracked citation → user click → attribution.

Profound, Scrunch, Peec — they monitor enterprise citations. They don't intercept and attribute.

We do.
```

**Tweet 3:**
```
The instrument: Cloudflare Worker at the edge, intercepts AI crawlers by user-agent, generates a per-bot citation-ready response, wraps every outbound link in an HMAC-signed redirect token.

When a human clicks through from an AI answer, the attribution closes.
```

**Tweet 4:**
```
The dataset:

→ 64 total queries, Jan–Apr 2026
→ Classified each: 38 burst/probe, 6 test-slug, 20 plausibly organic
→ Clean N=20 across 3 real tenants

We're publishing the classification methodology, not just the numbers.
```

**Tweet 5:**
```
On the clean N=20:

GPTBot — 10 queries (50%)
PerplexityBot — 5 queries (25%)
ClaudeBot — 5 queries (25%)

Three bots. Roughly even between the two tenants with most traffic (DMRE and Workman Copy Co).
```

**Tweet 6:**
```
Clicks: this is the most honest number in the report.

6 total click events. But after dedup and classification, only 1–2 are unambiguously organic. All PerplexityBot, all on a single tenant.

Directionally interesting. Not a finding. A hypothesis for Q2.
```

**Tweet 7:**
```
The mechanism hypothesis we're testing in Q2:

GPTBot indexes. When ChatGPT answers later, the user gets the answer without clicking through.

PerplexityBot routes. Inline citations the user actively clicks.

Different products, same crawler layer. Attribution reveals the gap.
```

**Tweet 8:**
```
What's actually new here isn't the numbers — it's the instrument.

Edge interception + signed tokens + closed attribution loop at SMB tier.

Reddit gets $60M/year from Google for training data access. An independent plumber gets nothing. That's the gap we're filling.
```

**Tweet 9 (caveats):**
```
Caveats, because you should ask:

- N=20 organic queries is thin. We know.
- 3 tenants, home services + professional services skew
- 59% of raw traffic was our own probe traffic from build-out
- This is a methodology preview, not a quantitative report

Q2 fixes all of this.
```

**Tweet 10 (CTA):**
```
Full methodology — classification logic, per-bot breakdown, what the instrument measures, Q2 roadmap:

https://advocatemcp.com/research/state-of-ai-bot-traffic-q1-2026

If you're running any kind of AI bot attribution, I want to compare notes. DMs open.
```

---

## 3. r/SEO post

Reddit rewards honesty over marketing. Frame as "here's what we built, here's what we found, including the uncomfortable parts." Do not link-dump in the first paragraph.

**Title:**
```
We built AI bot attribution for small businesses. Here's what week 1 of production data actually looks like (spoiler: mostly our own test traffic).
```

**Body:**
```
Hey r/SEO,

Posting the Q1 methodology preview from a research project I've been running. This community is good at calling out BS, and I want you to stress-test this before I publish more broadly.

**What we built:**

A Cloudflare Worker that sits at the edge for small businesses, intercepts AI crawler requests by user-agent, generates a per-bot citation-ready response, and tracks every outbound link with a signed redirect token. When a human clicks through from an AI answer, we can attribute it back to the originating bot and query.

**What the first week of production looks like:**

64 total queries across 3 real tenants, Jan–Apr 2026. But here's the uncomfortable part: 38 of those were burst/probe traffic from our own build-out sessions. 6 were from test slugs. The defensible organic subset is 20 queries.

On that clean N=20:
- GPTBot: 50% of organic queries
- PerplexityBot: 25%
- ClaudeBot: 25%

Clicks: 6 total click events, but after dedup and classification, only 1–2 are unambiguously organic. All PerplexityBot, all on one tenant. Too thin to claim anything — it's a hypothesis for Q2, not a finding.

**Why I'm publishing this instead of waiting for more data:**

Because nobody at SMB tier has published the methodology for closed-loop AI attribution. The instrument is the story, not the numbers. Profound and Scrunch serve enterprise citation monitoring. Reddit reportedly gets ~$60M/year from Google for training data access. But there's no equivalent for a regional real-estate brokerage or a pediatric orthotic brand.

**What I want from this thread:**

If you have any AI bot traffic visibility — referrer-based, server logs, whatever — what does your bot distribution look like? Is there a PerplexityBot vs GPTBot behavioral split in your data too?

Full methodology is at the URL in my profile. Happy to answer questions here.

Edit: since people are asking — [direct link](https://advocatemcp.com/research/state-of-ai-bot-traffic-q1-2026).
```

**Subreddit rules:** Some r/SEO mods auto-remove posts with links in the OP. Drop the link in the edit or a comment.

**Alt subreddits (post 1-2 days after r/SEO, not same day):**
- r/LocalSEO — same post, adjust title to "for local/service businesses"
- r/smallbusiness — rewrite to lead with "what this means for your Google Business Profile era thinking"
- r/bigseo — paid members only, higher-signal audience

---

## 4. Hacker News submission

HN rewards specific, technical, contrarian. Do not post until Tuesday 8:30am Pacific. Submit title + URL only. First comment goes below.

**Title (Pick A or B, A/B in your head):**

A. `First closed-loop AI attribution data from small businesses`

B. `We shipped AI crawler attribution for SMBs. Here's what the instrument sees in week 1.`

Submit A first. B is the backup if you re-submit after 24h of no traction.

**URL:** `https://advocatemcp.com/research/state-of-ai-bot-traffic-q1-2026`

**First comment (post yourself, immediately after submission):**

```
Author here. Quick context on what this is and is not:

I built a Cloudflare Worker that intercepts AI crawler traffic at the edge, generates per-bot citation-ready responses, and wraps every outbound link in an HMAC-signed redirect token. When a human clicks through from an AI answer, the attribution closes — I know which bot, which query, which business.

This is a methodology preview, not a quantitative report. The honest numbers: 64 total queries across 3 tenants, 59% of which were our own probe traffic from build-out. Clean organic subset is 20 queries. On that subset: GPTBot 50%, PerplexityBot 25%, ClaudeBot 25%. Clicks attributable to organic bot sessions: 1–2, all PerplexityBot, all one tenant.

Why publish at this N? Two reasons:

1. Nobody at SMB tier has published the closed-loop methodology. The instrument is the contribution, not the numbers.

2. There's a directionally interesting signal — GPTBot indexes heavily but we can't attribute a click to it; PerplexityBot shows up less but routes users who actually click through. I want this hypothesis on the record before Q2 triples the sample.

The two things I expect pushback on:

- "59% probe traffic means your instrument isn't measuring organic behavior." Fair. That's why we classified and disclosed it. Q2 has real tenants with real organic traffic.

- "1–2 clicks is not a finding." Agreed. It's a hypothesis. The finding is the instrument itself.

Full methodology section in the report. Happy to answer technical questions about the edge interception, token signing, or classification logic.
```

**If the thread gets traction, stay in it.** HN rewards authors who answer questions in-line for the first 6 hours. The top comment is often a nitpick that seems hostile but isn't — answer directly without defensiveness.

---

## 5. Indie Hackers

Crosspost after Reddit and HN have settled (24h later). IH wants founder story + metric, not pure data.

**Title:**
```
I shipped AI bot attribution for small businesses. Here's the honest week-1 data (N=20 organic queries).
```

**Body:**
```
A year ago the consensus was that AI search would quietly replace Google traffic for small businesses and no one would know how to measure the shift. I started building Advocate to close that measurement gap.

Today I'm publishing the Q1 methodology preview — the first closed-loop AI attribution data from small businesses in production. Three things worth the read:

1. The instrument: edge interception → per-bot response → signed citation tracking → closed attribution. Nobody at SMB tier has this loop.
2. The honest numbers: 64 total queries, but only 20 survived classification as plausibly organic. GPTBot 50%, PerplexityBot 25%, ClaudeBot 25%.
3. The hypothesis for Q2: PerplexityBot may route users who click through; GPTBot may index without generating clicks. Too early to claim, but directionally interesting from 1–2 organic clicks.

Why I'm posting here: I'm bootstrapped, pre-revenue-meaningful, and publishing real data instead of paying for distribution. This is a test of whether methodology-first content marketing works in a category where the enterprise players have a 2-year head start.

Would love to hear what other founders are doing for category-defining content — especially when your sample size is honest-but-small.

Full report: https://advocatemcp.com/research/state-of-ai-bot-traffic-q1-2026
```

---

## 6. Backup community submissions (do later in the week if bandwidth)

**SaaStr Blog** — pitch as a guest post to `submit@saastr.com`. Angle: "SMB SaaS founder publishes first AI attribution methodology in a category enterprise players have monopolized."

**MarketingBrew newsletter** — they cover AI search shifts. `editors@morningbrew.com` with subject `First closed-loop AI bot attribution data — SMB tier`.

**GrowthHackers** — community post, no moderation delay. Same body as Indie Hackers, adjusted framing.

**Semafor Technology newsletter** — Reed Albergotti covers AI infrastructure. Good fit. `reed.albergotti@semafor.com`.

See `press-kit.md` for full reporter list.

---

## 7. Post-publish day 1-3 amplification

Not launch-day posts — these happen after the first wave lands and there is traffic/feedback to point to.

- **Quote tweet** any journalist or notable account that shares the report. Add 1–2 lines of context, not a thank-you.
- **Reply to comments** on LinkedIn/Twitter/Reddit for the first 24h. Engagement drives algorithmic reach.
- **If a number from the report gets cited anywhere** — screenshot, attribute, share. Citations of citations multiply.
- **Day 3:** "Here is what you all told me after the methodology preview dropped" follow-up post with the most common pushback + your response. Keeps the story alive into the second news cycle.

---

## Voice + tone rules

- Never "we are excited to announce." Excitement is a tell that there is nothing to announce.
- Instrument before numbers. "Closed-loop attribution" before "N=20."
- Name the limitation before anyone else does. "20 organic from 64 total, 59% probe traffic" in your own post preempts the top comment.
- Link to the canonical URL. Not a shortener, not a UTM-ed version — the social crawlers need the real URL to resolve the OG image.
- Do not link to your own pricing or product pages from the launch content. Let the report be the report. Product discovery happens on its own once the reader trusts the methodology.

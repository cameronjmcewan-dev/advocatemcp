# State of AI Bot Traffic Q1 2026 — Launch Kit

Copy-paste-ready social posts and community submissions. Post in this order on publish day (see `send-sequence.md` for timing).

**Canonical URL:** `https://advocatemcp.com/research/state-of-ai-bot-traffic-q1-2026`

Use that URL everywhere. Do not shorten. Social crawlers need the canonical to hit the OG image.

---

## 1. LinkedIn post (primary)

Post from Cameron's personal profile. Tag Advocate page. Keep line breaks — they read better on LinkedIn than one wall of text.

```
We just ran the first SMB-tier measurement of AI crawler attribution and one number broke the model we had been operating under.

GPTBot sends 58% of AI crawler traffic to small businesses. PerplexityBot sends 31%.

Every click we could trace back to a bot came from PerplexityBot. Every single one. GPTBot converted at zero.

That is not a rounding error. That is two entirely different products behaving the same way at the crawler layer — one is indexing your site for a future answer, the other is actively routing a human user who clicked "view source" on a citation.

If you are optimizing for AI search right now, the implication is uncomfortable: most of the traffic you see in your server logs is the least valuable kind. The 31% that converts is the number to chase.

A few more things from the dataset (62 queries, 6 businesses, Jan–Apr 2026):

→ ChatGPTBot and Google-Extended showed up but at low volume
→ Intent split: 29% comparison shopping, 19% purchase-ready, 18% research
→ Latency is slow enough that it shapes which bots retry vs. fail quietly

We wrote this up because nobody at our tier is publishing this data. Profound and Scrunch are serving enterprise. SMB has been flying blind.

Full report — methodology, caveats, what we are measuring in Q2:
https://advocatemcp.com/research/state-of-ai-bot-traffic-q1-2026

I would love to hear from anyone else running this kind of measurement. What are you seeing?
```

**Length check:** ~1,900 characters. LinkedIn's sweet spot is 1,300–2,000 for organic reach.

---

## 2. Twitter/X thread

Post from `@cameronjmcewan` (or the Advocate handle if set up). One claim per tweet, concrete numbers on every line. Last tweet is the link — the algorithm penalizes links in the first tweet.

**Tweet 1 (hook):**
```
We measured which AI bots actually drive paying customers to small businesses.

GPTBot: 58% of crawler traffic.
PerplexityBot: 31% of crawler traffic.

Clicks that converted? 100% PerplexityBot. GPTBot: zero.

Thread 🧵
```

**Tweet 2:**
```
First: why this is the first time anyone has said this.

Profound and Scrunch are the serious tools here. Both are enterprise — Fortune 500 brand-tracking. There was no data on how AI crawlers actually behave at the SMB tier.

We built that measurement and ran it for Q1.
```

**Tweet 3:**
```
The dataset:

→ 6 businesses, 4 verticals
→ 62 bot queries Jan–Apr 2026
→ 6 attributed clicks (9.7% CTR)
→ Full server-side capture at the edge, attribution via HMAC-signed redirects

Small N. But it is real data from production traffic, not scraped citations.
```

**Tweet 4:**
```
The volume finding:

GPTBot — 36 queries (58.1%)
PerplexityBot — 19 queries (30.6%)
ChatGPT-User — 4 (6.5%)
Google-Extended — 2 (3.2%)
ClaudeBot — 1 (1.6%)

GPTBot dominates. If you only cared about crawler volume, you would build for OpenAI.
```

**Tweet 5:**
```
The conversion finding:

All 6 tracked clicks came from PerplexityBot. GPTBot generated zero.

That is a 36-query sample for GPTBot with zero outcomes. It is not statistically conclusive — but it is directionally striking enough to publish.
```

**Tweet 6:**
```
Why the split?

GPTBot is indexing. When ChatGPT later answers a query, it cites the cached content. The user may never click through to you.

PerplexityBot is routing. Its answers come with inline citations the user actively clicks. Perplexity is a referrer. GPTBot is a library.
```

**Tweet 7:**
```
Intent distribution on those 62 queries:

29% comparison shopping ("X vs Y")
19% purchase-ready ("book", "buy", "schedule")
18% research
Remainder: pricing, location, hours, credentials

Agentic commerce is already here. 1 in 5 AI bot queries is someone ready to transact.
```

**Tweet 8:**
```
What this changes for SMBs:

If PerplexityBot actually converts and GPTBot mostly doesn't (at our scale), the optimization target shifts. Feed PerplexityBot the structured, citation-ready answers. GPTBot will index you anyway.

Don't over-index on crawler share.
```

**Tweet 9 (caveats):**
```
Caveats, because you will ask:

- N=62 is small
- 3-month window, one seasonal slice
- 6 businesses, skewed toward home services
- Only attributes bots that send a Referer or UA we recognize

Q2 report will have 10x the N. We are publishing now so the direction is on the record.
```

**Tweet 10 (CTA):**
```
Full report — methodology, per-bot latency, intent breakdown, what Q2 measures differently:

https://advocatemcp.com/research/state-of-ai-bot-traffic-q1-2026

If you are running similar measurement, I want to compare notes. DMs open.
```

---

## 3. r/SEO post

Reddit rewards honesty over marketing. Frame as "here's what we found, including the awkward parts." Do not link-dump in the first paragraph.

**Title:**
```
We measured AI bot traffic + attribution for 6 small businesses in Q1 2026. GPTBot sent 58% of the traffic, PerplexityBot got 100% of the clicks.
```

**Body:**
```
Hey r/SEO,

Posting the Q1 results from a research project I have been running and hoping this community will be honest about what we got wrong, because some of the numbers surprised me.

**Setup:**

I run a tool that sits at the edge (Cloudflare Worker) for small businesses, intercepts AI crawler requests, returns a citation-ready response, and tracks every outbound citation link with a signed token so I can attribute downstream clicks. 6 businesses agreed to be part of the Q1 dataset. 62 AI bot queries captured Jan 1 – Apr 15 2026. 6 of those resulted in a human actually clicking through to the business site.

**The finding that surprised me:**

GPTBot sent 58.1% of the crawler queries. PerplexityBot sent 30.6%. But every single one of the 6 tracked clicks came from PerplexityBot. GPTBot's 36 queries produced 0 attributed clicks.

My read: GPTBot is indexing for later answers (cached, no click-through needed). PerplexityBot is live-routing — its answers surface citations the user actively clicks. If you're an SMB and you have limited bandwidth to optimize for AI search, it looks like PerplexityBot is the higher-ROI target, even though GPTBot shows up more in your logs.

**What I am not claiming:**

- This is not statistically conclusive. N=62 queries, N=6 clicks. I'm publishing directionally.
- My sample skews home services + professional services. B2B SaaS might behave completely differently.
- "0 GPTBot clicks" could be a measurement artifact. I spent time trying to rule that out and think it is real, but it is also the claim I am most curious whether anyone else can reproduce or refute.

**What I want from this thread:**

If you have any kind of AI bot traffic visibility (referrer-based, server logs, whatever), what does your PerplexityBot vs GPTBot split look like? And do your conversion rates diverge the same way?

Full methodology + data is at the URL in my profile. Happy to answer questions here without the link clutter.

Edit: fine, since people are asking — [direct link](https://advocatemcp.com/research/state-of-ai-bot-traffic-q1-2026).
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

A. `State of AI Bot Traffic Q1 2026: GPTBot sends the traffic, Perplexity gets the clicks`

B. `We measured AI crawler attribution for small businesses — GPTBot 58%, clicks 0%`

Submit A first. B is the backup if you re-submit after 24h of no traction.

**URL:** `https://advocatemcp.com/research/state-of-ai-bot-traffic-q1-2026`

**First comment (post yourself, immediately after submission):**

```
Author here. Quick context on what this is and is not:

I built a tool that intercepts AI crawler traffic at the edge and generates per-bot responses with signed attribution tokens on every outbound citation link. 6 small businesses have been in production on it. Q1 data is the first slice where I had enough traffic to publish anything.

The headline finding is the GPTBot/PerplexityBot split — GPTBot is dominating crawler volume but every attributed click in the sample came from Perplexity. Mechanism I think is at play: GPTBot is indexing for answer caching (the user never needs to click through once ChatGPT has the answer), Perplexity is routing (inline citations the user actively clicks).

The two things I expect pushback on and want to be upfront about:

1. N=62 queries, N=6 clicks. Directional, not conclusive. I'm publishing now because the direction is interesting enough to put on the record before Q2 triples the sample.

2. "Zero GPTBot clicks" is the kind of finding that triggers instrument-error hypotheses. I spent time trying to disprove it and think it is real — the attribution loop captured clicks from 5 other bot types including ClaudeBot with only 1 query — but I am genuinely interested if anyone can break the measurement.

Full methodology section in the report. Happy to answer technical questions about the edge interception, token signing, or anything else.
```

**If the thread gets traction, stay in it.** HN rewards authors who answer questions in-line for the first 6 hours. The top comment is often a nitpick that seems hostile but isn't — answer directly without defensiveness.

---

## 5. Indie Hackers

Crosspost after Reddit and HN have settled (24h later). IH wants founder story + metric, not pure data.

**Title:**
```
I shipped an AI bot attribution tool. Here's what Q1 data looks like for 6 small businesses.
```

**Body:**
```
A year ago the consensus was that AI search would quietly replace Google traffic for small businesses and no one would know how to measure the shift. I started building Advocate to fix that measurement gap.

Today I'm publishing the Q1 results from the first 6 businesses in production. Three findings worth the read:

1. GPTBot sends 58% of AI crawler traffic to SMBs. PerplexityBot sends 31%.
2. Every click we could attribute came from PerplexityBot. GPTBot's 36 queries produced zero attributed clicks in our sample.
3. 19% of AI bot queries are purchase-intent. Agentic commerce is already here, just thinly distributed.

Why I'm posting here: I'm bootstrapped, pre-revenue-meaningful, and I don't have a PR budget. I'm testing whether publishing real data can replace outbound. Would love to hear what other founders are doing for category-defining content marketing — especially in categories where the enterprise players have a 2-year head start.

Full report: https://advocatemcp.com/research/state-of-ai-bot-traffic-q1-2026
```

---

## 6. Backup community submissions (do later in the week if bandwidth)

**SaaStr Blog** — pitch as a guest post to `submit@saastr.com`. Angle: "SMB SaaS founder publishes first attribution data in a category enterprise players have monopolized."

**MarketingBrew newsletter** — they cover AI search shifts. `editors@morningbrew.com` with subject `AI crawler attribution data — exclusive`.

**GrowthHackers** — community post, no moderation delay. Same body as Indie Hackers, adjusted framing.

**Semafor Technology newsletter** — Reed Albergotti covers AI infrastructure. Good fit. `reed.albergotti@semafor.com`.

See `press-kit.md` for full reporter list.

---

## 7. Post-publish day 1-3 amplification

Not launch-day posts — these happen after the first wave lands and there is traffic/feedback to point to.

- **Quote tweet** any journalist or notable account that shares the report. Add 1–2 lines of context, not a thank-you.
- **Reply to comments** on LinkedIn/Twitter/Reddit for the first 24h. Engagement drives algorithmic reach.
- **If a number from the report gets cited anywhere** — screenshot, attribute, share. Citations of citations multiply.
- **Day 3:** "Here is what you all told me after the Q1 report dropped" follow-up post with the most common pushback + your response. Keeps the story alive into the second news cycle.

---

## Voice + tone rules

- Never "we are excited to announce." Excitement is a tell that there is nothing to announce.
- Numbers before narrative. "58%" before "dominant share."
- Name the limitation before anyone else does. "N=62, small N" in your own post preempts the top comment.
- Link to the canonical URL. Not a shortener, not a UTM-ed version — the social crawlers need the real URL to resolve the OG image.
- Do not link to your own pricing or product pages from the launch content. Let the report be the report. Product discovery happens on its own once the reader trusts the data.

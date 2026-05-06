# State of AI Bot Traffic Q1 2026 — Launch Kit

Copy-paste-ready social posts and community submissions. Post in this order on publish day (see `send-sequence.md` for timing).

**Canonical URL:** `https://advocatemcp.com/research/state-of-ai-bot-traffic-q1-2026`

Use that URL everywhere. Do not shorten. Social crawlers need the canonical to hit the OG image.

---

## 1. LinkedIn post (primary)

Post from Cameron's personal profile. Tag Advocate page. Keep line breaks — they read better on LinkedIn than one wall of text.

```
Advocate built and validated a closed-loop AI attribution instrument for small businesses. Today we're publishing the Q1 methodology preview of what it sees.

The instrument: a Cloudflare Worker that intercepts AI crawler requests at the edge, generates per-bot citation-ready responses, and wraps every outbound link in an HMAC-signed redirect token. When a human clicks through from an AI answer, the loop closes — the click is attributed back to the specific bot and the specific query that produced it.

Two scope notes up front, because they shape everything else:

→ Advocate has one paying customer to date (a copywriting agency). The other tenants in this dataset are our own pre-customer pilot installs we used to validate the pipeline before shipping to customers.
→ Six click events were captured in Q1. All six came from pilot validation, not from the customer side. The instrument works. Customer-facing conversion is Q2's job.

What the live-customer sample looked like (N=20 WCC queries, 9 organic after filtering our own probes):

→ PerplexityBot: 60%
→ ClaudeBot: 25%
→ GPTBot: 15%

That is the opposite of conventional wisdom about GPTBot dominance. But N is tiny. One vertical. One customer. Not a finding — a hypothesis worth quantifying at Q2 scale.

The gap this research exists to fill: Profound, Scrunch, Peec monitor enterprise citations. Reddit reportedly receives ~$60M/year from Google for training data access. No equivalent exists for a plumber in Austin or a pediatric orthotic brand. That is the loop we are closing.

Q2 lands in July with real customer volume and the first quantitative read. This report is the instrument, the caveats, and the first early signal on the record.

Full methodology:
https://advocatemcp.com/research/state-of-ai-bot-traffic-q1-2026

If you are running any kind of AI bot measurement, I want to compare notes.
```

**Length check:** ~1,800 characters. LinkedIn's sweet spot is 1,300–2,000 for organic reach.

---

## 2. Twitter/X thread

Post from `@cameronjmcewan` (or the Advocate handle if set up). One claim per tweet, concrete numbers on every line. Last tweet is the link — the algorithm penalizes links in the first tweet.

**Tweet 1 (hook):**
```
We built a closed-loop AI attribution instrument for small businesses. Today we're publishing what it sees in its validation phase and its first paying-customer week.

Methodology preview. Small N. Honest caveats. Q2 is the quantitative report.

Thread 🧵
```

**Tweet 2:**
```
Scope up front:

→ One paying customer in Q1 (a copywriting agency). 
→ Two other tenants are our own pre-customer pilot installs used to validate the pipeline.
→ Six click events captured in Q1 — all six from pilot validation, not from the customer side.

The instrument closes the loop. Market-side data is Q2.
```

**Tweet 3:**
```
The instrument itself:

Cloudflare Worker at the edge. Bot detection by user-agent. Per-bot citation-ready response. Every outbound link wrapped in an HMAC-signed redirect token.

Human clicks through from an AI answer → attribution back to the exact bot + exact query that produced the citation.
```

**Tweet 4:**
```
The dataset:

64 total bot queries, Apr 8–17 2026.
Classified by tenant type: 20 live-customer (WCC), 38 pilot validation, 6 internal test.
Classified by traffic type: 20 organic, 38 burst (our own probes), 6 test.

Defensible organic subset: N=20 across all tenant types.
```

**Tweet 5:**
```
Live-customer bot distribution (WCC, N=20, all queries):

PerplexityBot: 60%
ClaudeBot: 25%
GPTBot: 15%

That's the opposite of the industry-consensus "GPTBot dominates." But one customer, one vertical, nine days. Not a finding — a hypothesis worth quantifying.
```

**Tweet 6:**
```
Clicks — the most honest number in the report:

6 total click events. Zero from the customer side. All six from pilot-validation installs, all via PerplexityBot sessions.

The instrument captured them correctly. That was the point of validation. Customer-facing conversion lands in Q2.
```

**Tweet 7:**
```
Why the customer click count is zero at N=9 organic queries over nine days:

Because at N=9, a 10% click rate would produce 0–1 clicks. The number is statistically uninformative. Q2 will have the volume to start separating signal from noise on conversion.
```

**Tweet 8:**
```
What's actually new here isn't the numbers — it's the instrument.

Edge interception + signed tokens + closed attribution loop at SMB tier.

Reddit reportedly gets $60M/year from Google for training data access. An independent plumber gets nothing. That's the gap we're closing.
```

**Tweet 9 (caveats):**
```
Caveats, because you should ask:

- Live-customer ORGANIC N = 9. Nothing here is conclusive.
- One paying customer. Vertical generalizations are impossible until Q2.
- Nine-day window. No baseline to normalize against.
- All Q1 clicks came from pilot validation, not customer traffic.

Q2 fixes all four.
```

**Tweet 10 (CTA):**
```
Full methodology — tenant classification, per-bot breakdown, what the instrument measures, Q2 roadmap:

https://advocatemcp.com/research/state-of-ai-bot-traffic-q1-2026

If you're running any kind of AI bot attribution, I want to compare notes. DMs open.
```

---

## 3. r/SEO post

Reddit rewards honesty over marketing. Frame as "here's what we built, here's what we found, including the uncomfortable parts." Do not link-dump in the first paragraph.

**Title:**
```
We built AI bot attribution for small businesses. Here's the Q1 methodology preview — one paying customer, N=9 organic queries, and all the limits stated up front.
```

**Body:**
```
Hey r/SEO,

Posting the Q1 methodology preview from a research project I've been running. This community is good at calling out BS, and I want you to stress-test this before I publish more broadly.

**What we built:**

A Cloudflare Worker that sits at the edge for small businesses, intercepts AI crawler requests by user-agent, generates a per-bot citation-ready response, and tracks every outbound link with an HMAC-signed redirect token. When a human clicks through from an AI answer, we attribute it back to the originating bot and query.

**Scope — stated up front:**

Advocate has one paying customer in Q1 (a copywriting agency). The other tenants in the dataset are our own pre-customer pilot installs we used to validate the pipeline. Commingling them as "three tenants" would be dishonest. I'm calling them out separately.

**What the instrument saw:**

64 total bot queries, Apr 8–17 2026. Classified: 20 organic, 38 burst (our own probe traffic during build-out), 6 internal test. Further split by tenant type — 9 organic from the paying customer, 11 organic from pilot validation.

On the live customer (WCC, N=20 total across 20 queries):
- PerplexityBot: 60%
- ClaudeBot: 25%
- GPTBot: 15%

That's the opposite of industry reporting on GPTBot dominance. Tiny N, one vertical, not a finding — but worth quantifying at scale.

**Clicks:**

6 total click events in Q1. Zero from the paying customer. All six from pilot-validation installs, all PerplexityBot sessions. The instrument works end-to-end — it's just measuring mostly our own validation traffic at this stage. Q2 is the first quantitative read on customer-side conversion.

**Why publish at this N instead of waiting:**

Because I'd rather publish the instrument and the method now, warts visible, than wait three months and retrofit a cleaner narrative. Profound, Scrunch, Peec monitor enterprise citations. There's no SMB equivalent. I wanted the method on the record before Q2 triples the sample.

**What I want from this thread:**

Tear the method apart. If you have any AI bot traffic visibility — referrer-based, server logs, anything — does the PerplexityBot-vs-GPTBot split look different in your data? Is our tenant classification framework usable? Would you draw a different line between "probe" and "organic"?

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

A. `State of AI bot traffic for small businesses (Q1 2026 methodology preview)`

B. `We built AI crawler attribution at SMB tier. Here's what the instrument sees in validation.`

Submit A first. B is the backup if you re-submit after 24h of no traction.

**URL:** `https://advocatemcp.com/research/state-of-ai-bot-traffic-q1-2026`

**First comment (post yourself, immediately after submission):**

```
Author here. Quick context on what this is and is not:

I built a Cloudflare Worker that intercepts AI crawler traffic at the edge, generates per-bot citation-ready responses, and wraps every outbound link in an HMAC-signed redirect token. When a human clicks through from an AI answer, the attribution closes — the click ties back to the specific bot and specific query that produced it.

This is a methodology preview, not a quantitative report. The honest scope:

- One paying customer in Q1 (a copywriting agency). Two other tenants are our own pre-customer pilot installs we used to validate the pipeline.
- 64 total bot queries across all tenants. After classifying out our own probe traffic and internal test slugs, the defensible organic subset is N=20 (9 live-customer, 11 pilot-validation).
- 6 click events captured end-to-end. All six came from the pilot-validation tier, zero from the paying customer. That is within the noise floor at N=9 over nine days.

The one finding from the live-customer sample that's worth stating, with heavy caveat: on the live customer (B2B copywriting agency, N=20 total queries), PerplexityBot was 60% of traffic, ClaudeBot 25%, GPTBot 15%. Opposite of the "GPTBot dominates" conventional wisdom. Tiny N, one vertical, not a finding — a hypothesis worth quantifying at Q2 scale.

Why publish at this N? Because the instrument is the contribution. Nobody at SMB tier has closed the loop from crawler query → bot-specific response → signed citation → user click → attribution. I wanted the method on the record before Q2, which is when the quantitative report lands.

Two things I expect pushback on:

- "One customer isn't a market." Correct. The report title is "methodology preview" for that reason. Q2 is the first quantitative version.
- "All your clicks came from your own pilot installs." Correct, and that's what you'd expect for a pipeline in its validation phase. The clicks prove the loop closes. Customer-facing conversion is Q2's measurement.

Full methodology, caveats, and Q2 roadmap in the report. Happy to answer technical questions about the edge interception, token signing, or the tenant-classification framework.
```

**If the thread gets traction, stay in it.** HN rewards authors who answer questions in-line for the first 6 hours. The top comment is often a nitpick that seems hostile but isn't — answer directly without defensiveness.

---

## 5. Indie Hackers

Crosspost after Reddit and HN have settled (24h later). IH wants founder story + metric, not pure data.

**Title:**
```
I shipped AI bot attribution for small businesses. Here's the honest Q1 preview — one paying customer, the instrument works, Q2 is the quantitative report.
```

**Body:**
```
A year ago the consensus was that AI search would quietly replace Google traffic for small businesses and no one would know how to measure the shift. I started building Advocate to close that measurement gap.

Today I'm publishing the Q1 methodology preview. Three things worth the read:

1. **The instrument is built and validated.** Edge interception → per-bot response → signed citation tracking → closed attribution loop. Six click events captured end-to-end in Q1, all six from our own pre-customer pilot installs during validation. The pipeline works — the market-side numbers are Q2's job.

2. **The scope is one paying customer.** First customer onboarded mid-window. The other tenants in the dataset are our own pilot installs we stood up to validate the pipeline before customer release. I treat them separately in the report instead of padding the customer count.

3. **The one live-customer signal worth flagging.** On the live customer (N=20 queries), PerplexityBot was 60% of traffic, GPTBot only 15%. Opposite of the GPTBot-dominance consensus. N is too small to generalize — but it's on the record as a hypothesis Q2 can quantify.

Why I'm posting here: I'm bootstrapped, pre-meaningful-revenue, and publishing real data instead of paying for distribution. This is a test of whether methodology-first content marketing works in a category where the enterprise players have a 2-year head start.

Would love to hear what other founders are doing for category-defining content — especially when your sample size is honest-but-small.

Full report: https://advocatemcp.com/research/state-of-ai-bot-traffic-q1-2026
```

---

## 6. Backup community submissions (do later in the week if bandwidth)

**SaaStr Blog** — pitch as a guest post to `submit@saastr.com`. Angle: "SMB SaaS founder publishes AI attribution methodology in a category enterprise players have monopolized."

**MarketingBrew newsletter** — they cover AI search shifts. `editors@morningbrew.com` with subject `Closed-loop AI bot attribution at SMB tier — Q1 methodology preview`.

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
- Name the limitation before anyone else does. "One paying customer, N=9 organic on the customer side, all six clicks came from pilot validation" in your own post preempts the top comment.
- Link to the canonical URL. Not a shortener, not a UTM-ed version — the social crawlers need the real URL to resolve the OG image.
- Do not link to your own pricing or product pages from the launch content. Let the report be the report. Product discovery happens on its own once the reader trusts the methodology.

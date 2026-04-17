# State of AI Bot Traffic Q1 2026 — Send Sequence

Step-by-step runbook for publish day and the week after. Print this or leave it open in a tab.

**Target publish date:** Tuesday, [pick the next Tuesday at least 4 days out], 8:00 AM Pacific.

Tuesday 8am PT because:
- Tech/trade reporters are at their desks from 9am ET onward
- HN's morning reading peak starts ~9am PT, so an 8:30 submission catches it
- LinkedIn morning-coffee peak is 8–10am in each timezone; starting at 8am PT cascades across US timezones
- Avoids Monday (catching up from weekend) and Wed+ (news cycle already committed)

---

## T-minus 48 hours (Sunday 8am PT)

Heads-up emails to a tight circle. One-line, no ask, no link.

**Recipients (5 total):**
- The one paying customer who agreed to be on-record (WCC's owner)
- 1–2 "friends of the company" who will boost organically — other solo SaaS founders with relevant audiences
- 1 journalist you have a warm relationship with (if any) — give them the link as a private embargo

Template:

```
Subject: Heads-up — publishing Tuesday

Hi [name],

Publishing our first State of AI Bot Traffic report Tuesday 8am PT. TL;DR:
Advocate built and validated a closed-loop AI attribution instrument for
small businesses. Q1 is the methodology preview. Q2 is the first
quantitative report.

No ask — just want you to hear it from me before the socials. Happy to
send the full report early if useful.

Cameron
```

---

## T-minus 24 hours (Monday 8am PT)

**Final checks.** Run these commands in order:

```bash
# 1. Verify the report renders locally
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
open site/research/state-of-ai-bot-traffic-q1-2026.html

# 2. Check OG image renders
open site/research/state-of-ai-q1-2026-og.png

# 3. Verify deploy script exists and works
ls -la scripts/deploy-pages.sh
```

**Pre-flight checklist:**

- [ ] Report proofread one more time. Read it aloud to catch anything clunky.
- [ ] Both external citations still 200 (InfoQ, CJR). Click each. ALM was retracted (NXDOMAIN).
- [ ] OG image preview tool: paste `https://advocatemcp.com/research/state-of-ai-bot-traffic-q1-2026` into `https://www.opengraph.xyz` — verify image, title, description all render.
- [ ] Twitter card validator: `https://cards-dev.twitter.com/validator` — same paste, verify `summary_large_image` card renders.
- [ ] LinkedIn post inspector: `https://www.linkedin.com/post-inspector/` — same paste.
- [ ] Double-check pricing page link from the report footer works.
- [ ] Phone is on. Journalist replies may come as calls.
- [ ] Alcohol in the fridge for Tuesday night.

---

## T-hour 0 (Tuesday 8:00 AM PT) — PUBLISH

**Run these in this exact order. Don't multitask, don't batch.**

### 8:00 AM — Deploy

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git checkout main
git pull
git merge feature/state-of-ai-q1-launch --no-ff
git push origin main
./scripts/deploy-pages.sh
```

Verify live: `curl -I https://advocatemcp.com/research/state-of-ai-bot-traffic-q1-2026` returns 200.
Verify OG: visit the URL, view page source, confirm `og:image` meta tag points at the rendered PNG URL.

### 8:15 AM — Wave 1 press pitches

Send Wave 1 press emails (5 reporters, see `press-kit.md`). Send one at a time, not a BCC blast. Personalize the opening line for each.

### 9:00 AM — LinkedIn post

Post the LinkedIn content from `launch-kit.md` section 1. Post from Cameron's personal account. Pin to profile for 7 days.

### 9:30 AM — Twitter thread

Post the 10-tweet thread from `launch-kit.md` section 2. Paste each tweet one at a time — do not use a thread-scheduling tool (algorithm penalty). Reply-to-self for each subsequent tweet.

### 10:00 AM — Hacker News submission

Submit to Hacker News. Title A from `launch-kit.md` section 4. Do not use "Show HN:" prefix — this is not a show-and-tell, it is research. Immediately post the author comment from the kit.

### 10:15 AM — Watch and engage

For the next 2 hours, monitor:
- HN thread — reply to every top-level comment within 15 minutes. Even nitpicks.
- Twitter replies — quote-tweet any good amplifier, reply to any question.
- LinkedIn comments — reply, don't auto-like.
- Email — journalist replies come in waves. Answer immediately if it's a yes.

**Do not** start Reddit post yet. Wait until HN has settled one way or another.

### 12:30 PM — Reddit /r/SEO post

By now HN will have either risen to front page (great, Reddit will echo it) or plateaued (fine, Reddit is a fresh audience). Post to r/SEO using the template in `launch-kit.md` section 3. Drop the link in a comment reply, not the OP, to respect sub rules.

### 2:00 PM — Indie Hackers crosspost

Post to Indie Hackers using `launch-kit.md` section 5. Different framing (founder story) keeps it from feeling redundant to people who saw LinkedIn.

### 3:00 PM — End of day 1 checkpoint

Look at:
- HN front page? (If yes, stay at the keyboard till 11pm responding.)
- Any journalist replies? Queue follow-up calls for tomorrow.
- Reddit upvotes trending? (If yes, second comment with one more data point from the report — keeps the thread alive.)

---

## Day 2 (Wednesday)

### 9:00 AM — Wave 2 press pitches

Wave 2 trade press (5 reporters from `press-kit.md`). Subject B for these — they want research, not news.

### 10:00 AM — Engage Day 1 momentum

- Reply to any overnight HN/Reddit comments.
- Quote-tweet any account that shared the report yesterday. Add one line of context.
- If any journalist replied "yes interested, can we talk?" → book them first thing today. Do not let interest decay.

### 2:00 PM — r/LocalSEO crosspost

Different audience than r/SEO. Adjust title angle to "what this means for local businesses" per kit.

### 3:00 PM — Nudge silent Wave 1

One-line email to any Wave 1 reporter who didn't reply:

```
Subject: Re: [original subject]

Just checking — did this land? Happy to answer anything on the method if useful. No follow-up after this.

Cameron
```

---

## Day 3 (Thursday)

### 9:00 AM — Wave 3 press pitches

Wave 3 business/founder-story reporters (5 from `press-kit.md`).

### 11:00 AM — r/smallbusiness post

Post with reframed angle — "what this means for Google Business Profile-era thinking." Smaller audience but higher purchase intent.

### 2:00 PM — First customer outreach off the report

Email your paying customer (WCC). Subject: `You're part of Q1's research`. Thank them, show them the report, offer a private data cut showing their tenant's stats in context. This is retention gold — and worth treating with extra care given they are the only live-customer data point in Q1.

---

## Day 5–7 (Friday–Sunday)

### Wave 4: long-form + newsletters

`press-kit.md` Wave 4 — Ben Thompson, Dan Shipper, Lenny, Packy. Slower cycle. Ben probably won't reply and that's fine. Dan Shipper has a history of publishing founder-research.

### Weekend content

Saturday: short Twitter post with one chart from the report that didn't make the tweetthread. "Here's one more chart from the Q1 data" + image. No link (LinkedIn/Twitter reward native content). Drives secondary impressions.

Sunday: rest. Nobody is reading business Twitter on Sunday.

---

## Day 10 followup

### "What I heard" LinkedIn post

Long-form LinkedIn post (personal account) titled something like:

> "I published AI bot attribution data 10 days ago. Here's what the pushback looked like and where I updated my priors."

This is the second news cycle. It reframes any critique you got into evidence that you're listening, and it re-distributes the original report to anyone who missed the first wave. Average LinkedIn lifespan is 7 days; this is your excuse to bring it back.

### Consolidation email to engaged reporters

Any reporter who replied with interest but didn't place — email:

```
Subject: Q2 exclusive?

Hi [name],

Thanks for engaging on the Q1 piece. Planning to publish Q2 data in
[month] with 10x the sample and per-vertical breakdown. Happy to give
you a 48-hour embargo exclusive if the story angle fits. Want me to
loop you in when it's ready?

Cameron
```

---

## Measurement — what to track

Simple Google Sheet (no dashboards). Columns:

- Date
- Source (LinkedIn / Twitter / Reddit / HN / direct)
- Pageviews on report URL
- Unique visitors
- Time on page (> 2min = engaged read)
- Outbound clicks to pricing / signup
- New signups that cite "State of AI report" as source
- Press placements (count)

**Targets — not KPIs, just expectations.**

- Week 1: 2,000–5,000 uniques on the report URL
- Week 1: 1–2 tier-1 press placements
- Week 1: 50–100 new signups to the newsletter (if it exists)
- Week 2: 10–20 trial signups attributed to the report
- Week 4: 2–5 paying customers directly traceable to Q1 report exposure

If you hit the low end of each, that is a successful Q1 launch. Q2 builds on this list.

---

## If something goes wrong

### The HN thread gets flagged / buried

Don't re-submit the same URL. Write a companion blog post with a different angle ("Why our one-customer sample showed PerplexityBot dominance when industry reports say GPTBot — and what Q2 will actually measure") and submit that to HN on day 5. Fresh URL, related content, no rule violation.

### A reporter writes a piece that misrepresents the data

Reply publicly on Twitter with the correction. Polite, specific, cite the methodology section. Do not email the reporter privately demanding a correction — social public correction is higher-integrity and harder to ignore.

### A big account dunks on the methodology

Reply in-thread. Concede anything legitimate. Correct anything factually wrong. A dunk is free distribution if you handle it with grace.

### No one notices

This is the most likely failure mode. Real response: take the miss, commit to Q2 data with 10x sample, try again in 3 months with a larger story. Category definition is 3–4 reports, not 1.

---

## Do not

- Do not schedule social posts via Hootsuite/Buffer/etc. Algorithm penalty is real.
- Do not run paid amplification on the LinkedIn post. It looks desperate and triggers the wrong audience.
- Do not email Cloudflare BD the report on launch day. Wait 2 weeks. Let it accumulate press.
- Do not cross-pitch the same reporter at two outlets.
- Do not gate the report behind an email signup. Gated research is dead research.

---

## When it's over

Friday of week 2, open a new doc: `docs/research/state-of-ai-bot-traffic-q1-2026.retro.md`. Capture what worked, what flopped, what you'd change in Q2. The retro is how Q2 gets better.

# State of AI Bot Traffic Q1 2026 — Press Kit

Pitch email, reporter list, and FAQ for journalist outreach. Goal: 2–3 placements in tier-1 outlets within 2 weeks of publish.

**Canonical URL:** `https://advocatemcp.com/research/state-of-ai-bot-traffic-q1-2026`

---

## Pitch email template

Keep it under 200 words. Reporters skim. Lead with the instrument (what's new), then the early signal, then the offer.

### Subject line A/B — pick one per outlet, don't A/B within one reporter

A. `First closed-loop AI attribution data from small businesses — methodology preview`

B. `We built AI crawler attribution for SMBs. Publishing the first week of production data.`

C. `Nobody has measured which AI bot drives revenue to small businesses. We just started.`

**Defaults:**
- Tier-1 general tech (TechCrunch, Fortune, Axios): use A. The novelty is the hook.
- Trade/industry (Search Engine Land, Marketing Brew, The Information): use B. Sounds like research, not pitch.
- Independent reporters who cover AI infrastructure specifically: use C. They'll appreciate the gap framing.

### Body

```
Hi [FIRST NAME],

I run a tool that intercepts AI crawler requests at the edge for small businesses, generates per-bot citation-ready responses, and tracks every outbound link with a signed redirect token so I can attribute downstream clicks back to the specific bot that drove them.

Today I'm publishing a methodology preview — the first week of production data across three real tenants. Honest numbers: 20 organic queries classified from 64 total (59% was our own probe traffic from build-out, fully disclosed).

On the clean subset: GPTBot sent 50% of queries, PerplexityBot 25%, ClaudeBot 25%. The only organic click we could unambiguously attribute came from PerplexityBot. Too early to claim a pattern, but the instrument is working and Q2 will be the first quantitative report.

Nobody at SMB tier has closed this attribution loop before. Profound and Scrunch monitor enterprise citations. Reddit gets ~$60M/year from Google for training data access. But there's no equivalent for an independent plumber or a pediatric orthotic brand.

Happy to walk through the method on a call — I can show live traffic hitting a real tenant and the attribution loop closing end to end.

Cameron McEwan
Founder, Advocate
[phone]
```

**Why this version works:**
- Opens with what you do in plain language
- Leads with the instrument (novelty), not a single number
- Discloses the probe-traffic ratio upfront — reporter trust
- Offers a call with live demo

---

## Reporter list

Priority tiers. Send in waves — 5 per day, not all 20 at once. Over-dispatching gets flagged as spam.

### Wave 1 — tier-1 tech, day 1 (Tuesday after publish)

1. **Kate Clark — TechCrunch** — covers AI + SaaS funding. She wrote the Scrunch $19M Series A piece. `kate.clark@techcrunch.com`
2. **Sara Perez — TechCrunch** — consumer AI + SMB tools. Wrote on ChatGPT Apps SDK launch. `sarah.perez@techcrunch.com`
3. **Reed Albergotti — Semafor** — AI infrastructure. Sharp on crawler + search. `reed.albergotti@semafor.com`
4. **Maxwell Zeff — TechCrunch** — AI research + benchmarks. Will appreciate methodology. `maxwell.zeff@techcrunch.com`
5. **Ashley Capoot — CNBC** — covers AI search + advertising shifts. `ashley.capoot@nbcuni.com`

### Wave 2 — trade / deep-tech, day 2

6. **Barry Schwartz — Search Engine Land** — the definitive SEO trade press. This report is directly in his beat. `barry@rustybrick.com`
7. **Danny Goodwin — Search Engine Journal** — same beat, slightly different audience. `dgoodwin@searchenginejournal.com`
8. **Sara Fischer — Axios Media Trends newsletter** — she reported on Reddit/Google/OpenAI licensing deals. AI + publisher economics. `sara.fischer@axios.com`
9. **Matthew Kazmierczak — MarTech** — marketing-tech trade, covers attribution thoroughly. `mkazmierczak@martech.org`
10. **Marc Schenker — MarketingBrew (Morning Brew)** — AI search. Newsletter audience of 6M marketers. `editors@morningbrew.com`

### Wave 3 — business + founder-story, day 3

11. **Jessica Mathews — Fortune Term Sheet** — VC/startup angle. Advocate vs Profound is a Term Sheet story. `jessica.mathews@fortune.com`
12. **Anita Ramaswamy — The Information** — B2B SaaS + founder profiles. `anita@theinformation.com`
13. **Rebecca Bellan — TechCrunch** — covers agents + commerce. The methodology angle is her beat. `rebecca.bellan@techcrunch.com`
14. **Hayden Field — CNBC** — AI + enterprise adoption. `hayden.field@nbcuni.com`
15. **Kyle Wiggers — TechCrunch** — AI policy + research tooling. `kyle.wiggers@techcrunch.com`

### Wave 4 — newsletters + podcasts, day 5–7

16. **Ben Thompson — Stratechery** — thesis-driven analyst. Don't pitch, email the link with one line: "Thought this might interest you given your Aggregation Theory writing on AI search." `ben@stratechery.com`
17. **Dan Shipper — Every / How Do You Use ChatGPT?** — publishes founder-led research. `dan@every.to`
18. **Lenny Rachitsky — Lenny's Newsletter** — SMB SaaS product. Pitch the founder-story angle. `lenny@lennysnewsletter.com`
19. **Ashu Garg — Foundation Capital (Unsupervised Learning podcast)** — invests in AI infra. Guest pitch. `ashu@foundationcap.com`
20. **Packy McCormick — Not Boring** — founder-story long-form. `packy@notboring.co`

### Do NOT pitch (yet)

- Sequoia / Kleiner / Lightspeed writers — those are Profound's investors. Let them come inbound if they come at all.
- Any reporter who already covered a Scrunch or Profound piece in the last 30 days — they are already "done" on the beat.
- The Verge, Wired — too generalist for this specific story. Wait for a bigger arc.

### Followups

48 hours after each wave, one-line nudge to anyone who didn't reply: "Did this land? Happy to answer anything on method." No attachments. No re-pitching.

---

## Press FAQ

Anticipate and pre-answer. Keep these in a single doc open in another tab during press calls.

### Q1: How is this different from what Profound and Scrunch publish?

Profound and Scrunch measure which brands are cited in AI answers (Fortune 500 scope). We measure which bots drive revenue-attributable traffic to small businesses. Theirs is an audit of what the AI says about you. Ours is an audit of who actually sends you business.

Short version: they measure visibility, we measure attribution.

### Q2: The sample size is very small. Why publish now?

Three reasons. First, nobody at SMB tier has published the closed-loop methodology — the instrument is the contribution, not the numbers. Second, we're explicit about the limits: 20 organic queries classified from 64 total, 59% probe traffic from build-out, 1–2 unambiguously organic clicks. We disclose the classification in the methodology section.

Third, there's a directionally interesting signal — PerplexityBot routes users who click through while GPTBot's queries haven't produced an attributed click yet. We want this hypothesis on the record before Q2 triples the sample. We're not asking reporters to bet on the numbers — we're asking them to cover the instrument and the methodology.

### Q3: "Only 1–2 organic clicks" — is the instrument even working?

Yes. The attribution loop captured click events across multiple bot types and tenants. The signed redirect tokens resolve correctly. The reason the organic click count is low is that the tenants are new — they've been in production for one week. Q2 will have a full quarter of organic traffic across more tenants.

What we can say: the instrument attributed its first organic bot click on April 10 (DMRE tenant, PerplexityBot, query about commercial land sales). That's the proof the loop closes. Scale is what Q2 adds.

### Q4: Is this a paid tool? Are you selling something?

Yes — Advocate is a SaaS product (pricing at advocatemcp.com/pricing). The report is not gated. We published it because attribution data at this tier has not existed, not because we are running a lead-gen campaign. Journalists who want to frame it as promotional content have every right to. We think the methodology speaks for itself; the commercial incentive does not change the instrument.

### Q5: Can I verify your data independently?

Yes. Three ways:

1. The methodology section of the report lists the classification logic, time windows, and the attribution mechanism (HMAC-SHA256 signed redirect tokens).
2. We can walk you through the live instance on a call — show a bot query hitting the edge, the response being generated, and a simulated click resolving back through the attribution endpoint.
3. We publish the Advocate manifest at `/.well-known/mcp.json` for any tenant site, which documents the capabilities and schemas the measurement depends on.

### Q6: What about privacy?

No PII is captured in the research dataset. Click events log bot-identity, request-ID, timestamp, source URL. User-level data (IP, device, identity) is not part of this measurement. The signed token is opaque — it binds a click to the bot query that spawned it, not to the user who clicked.

### Q7: What is the Q2 report going to measure differently?

Three upgrades:

1. Sample size — target 50+ businesses, 500+ queries, Q2 full quarter.
2. Per-vertical breakdown — home services vs. professional services vs. local retail. The Q1 sample is too small to split.
3. Conversion-beyond-click — did the click result in a booking, quote request, or revenue event? Q1 stopped at the click. Q2 closes the loop to the outcome.

### Q8: Are you funded?

Bootstrapped. Running on $0 outside revenue. Cofounder + solo engineer. Full transparency in the report's "About Advocate" section.

### Q9: Do you have customers who will talk on the record?

Yes, with permission. We can connect you with 1–2 small-business owners who are customers and have agreed to speak. Reach out and we'll coordinate.

### Q10: What's the business model?

Flat monthly subscription per business (Base $100, Pro $250). We do not take a cut of transactions. We do not sell the attribution data. The business owns their tenant data.

---

## Embargoed briefings (optional, tier-1 only)

If you want a tier-1 reporter to break the story before the public publish, offer an embargoed briefing 48 hours before. Only worth doing for:

- Semafor (Albergotti) — will appreciate the exclusive
- Stratechery (Thompson) — rarely covers individual startup news but the thesis fits his beat
- The Information (Ramaswamy) — embargo-friendly, paid audience

Embargo email language:

```
Hi [FIRST NAME],

Publishing Q1 AI attribution methodology preview on [DATE] public. Offering an embargoed briefing 48 hours prior if helpful — instrument walkthrough, early data, and a call with me to ask anything. Embargo would lift at [TIME] on [DATE], matching public publish.

Two sentences on what's new: first closed-loop AI attribution data from small businesses. 20 organic queries, 3 tenants, 3 bots — methodology preview before the quantitative Q2 report.

Interested?

Cameron
```

If they pass, no hard feelings. If they accept, send the report PDF + methodology doc, then have the call the next day.

---

## Followup cadence

Day 1 (publish): Wave 1 pitches go out in the morning, social posts in the afternoon.
Day 2: Wave 2 pitches go out. Reply to any Wave 1 questions. Nudge any Wave 1 silence after 24h.
Day 3: Wave 3 pitches go out. Monitor inbound.
Day 5: Wave 4 pitches + any followup to silent Wave 2/3 reporters with one-line nudge.
Day 10: Consolidation email to any reporter who engaged but didn't place: "Saw you liked the methodology — happy to provide the Q2 exclusive when ready."

---

## Track results

Simple sheet. Columns: Reporter, Outlet, Date pitched, Date replied, Placement link, Notes.

A 10% placement rate on this list (2 pieces) is a realistic target. A 20% rate (4 pieces) is an excellent outcome. Anything above that is outlier luck — don't overfit the next quarter's pitch on it.

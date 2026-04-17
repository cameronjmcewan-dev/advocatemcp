# State of AI Bot Traffic Q1 2026 — Press Kit

Pitch email, reporter list, and FAQ for journalist outreach. Goal: 2–3 placements in tier-1 outlets within 2 weeks of publish.

**Canonical URL:** `https://advocatemcp.com/research/state-of-ai-bot-traffic-q1-2026`

---

## Pitch email template

Keep it under 200 words. Reporters skim. Lead with the instrument (what's new), then the early signal, then the offer.

### Subject line A/B — pick one per outlet, don't A/B within one reporter

A. `Closed-loop AI attribution at SMB tier — Q1 methodology preview`

B. `We built AI crawler attribution for small businesses. Publishing the validated instrument + first customer data.`

C. `Nobody has measured which AI bot drives revenue to small businesses. We just built the instrument.`

**Defaults:**
- Tier-1 general tech (TechCrunch, Fortune, Axios): use A. Specific and defensible.
- Trade/industry (Search Engine Land, Marketing Brew, The Information): use B. Sounds like research, not pitch.
- Independent reporters who cover AI infrastructure specifically: use C. They'll appreciate the gap framing.

### Body

```
Hi [FIRST NAME],

I run a tool that intercepts AI crawler requests at the edge for small businesses, generates per-bot citation-ready responses, and tracks every outbound link with an HMAC-signed redirect token so a human click from an AI answer can be attributed back to the exact bot and exact query.

Today I'm publishing the Q1 methodology preview. Honest scope up front: one paying customer in Q1 (a copywriting agency); the other tenants in the dataset are our own pre-customer pilot installs used to validate the pipeline. Six click events captured end-to-end — all six from pilot validation, zero from the customer side yet. The instrument is validated; Q2 is the first quantitative report.

One signal worth flagging from the live-customer sample (N=20 queries): PerplexityBot was 60% of crawler traffic on that tenant, GPTBot only 15%. Opposite of conventional wisdom, but N is too small to generalize. Q2 quantifies.

Nobody at SMB tier has closed this attribution loop before. Profound and Scrunch monitor enterprise citations. Reddit reportedly gets ~$60M/year from Google for training data access. No equivalent exists for an independent plumber or a pediatric orthotic brand.

Happy to walk through the method on a 20-minute call — I can show the pipeline live against a real tenant and demonstrate a click resolving end-to-end.

Cameron McEwan
Founder, Advocate
[phone]
```

**Why this version works:**
- Opens with what you do in plain language
- Leads with the validated instrument, not a single number
- Discloses the one-customer, pilot-validation framing up front — reporter trust
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

### Q2: Why publish now, when you have one paying customer and N=9 organic queries on the customer side?

Because the instrument is the contribution, and the honest version of the story is the validation-phase version. We built a closed-loop AI attribution pipeline — edge interception, per-bot response, signed citation, click resolution, full end-to-end attribution — and we validated it on our own pre-customer pilot installs before pointing it at our first paying customer. Six click events captured end-to-end in Q1, all six in the pilot-validation tier. That's what a working instrument in its first week looks like.

We could have waited three months, collected customer-side data, and presented a tidier narrative. That version would have been less honest than this one. Q2 is the first quantitative report with a multi-customer organic sample. Q1 is the methodology on the record, caveats first, so the method can be evaluated before the numbers get bigger.

### Q3: Your data shows PerplexityBot dominating on one customer, but most public industry reporting says GPTBot is the dominant AI crawler. Why does this contradict?

Because we have one paying customer, in one vertical (B2B copywriting agency), measured over nine days, N=20 total queries. That is not a market. On that one tenant, the distribution was 60% PerplexityBot, 25% ClaudeBot, 15% GPTBot — roughly the inverse of what most public crawler-rank studies report.

I do not claim this generalizes. What I claim is that it is the first live-customer data point in print at SMB tier, and it is sufficiently contrarian to conventional wisdom that it deserves to be quantified at Q2 scale rather than hand-waved away.

Three plausible reasons the customer-side number might legitimately differ from industry aggregates: (1) SMB domains may see a different crawler mix than the large publishers most crawler-rank studies draw from; (2) PerplexityBot's per-query behavior is routing-oriented — it hits origin to cite, not to train — while GPTBot's training-oriented crawls may concentrate on different domain profiles; (3) a B2B copywriting agency is not a plumber. Q2 will have multiple verticals and enough volume to separate these hypotheses.

### Q4: Is this a paid tool? Are you selling something?

Yes — Advocate is a SaaS product (pricing at advocatemcp.com/pricing). The report is not gated. We published it because attribution data at this tier has not existed, not because we are running a lead-gen campaign. Journalists who want to frame it as promotional content have every right to. We think the methodology speaks for itself; the commercial incentive does not change the instrument.

### Q5: Can I verify your data independently?

Yes. Three ways:

1. The methodology section of the report lists the tenant classification framework, the burst/organic filter logic, the time windows, and the attribution mechanism (HMAC-SHA256 signed redirect tokens).
2. We can walk you through the live instance on a call — show a bot query hitting the edge, the response being generated, and a simulated click resolving back through the attribution endpoint.
3. We publish the Advocate manifest at `/.well-known/mcp.json` for any tenant site, which documents the capabilities and schemas the measurement depends on.

### Q6: What about privacy?

No PII is captured in the research dataset. Click events log bot-identity, request-ID, timestamp, source URL. User-level data (IP, device, identity) is not part of this measurement — we prefix-truncate client IPs before hashing them for deduplication, so a full user IP cannot be reconstructed from our logs. The signed token is opaque — it binds a click to the bot query that spawned it, not to the user who clicked.

### Q7: What is the Q2 report going to measure differently?

Four upgrades:

1. **Sample size.** Target a materially larger customer cohort and a full-quarter window.
2. **Per-vertical breakdown.** Home services vs. professional services vs. local retail. Q1's single-customer sample cannot split. Q2 will.
3. **Conversion beyond click.** Did the click result in a booking, quote request, or revenue event? Q1 validated the click. Q2 measures what happens after.
4. **Per-agent attribution.** Our per-agent reputation rollup shipped in April 2026. Q2 is the first report that can attribute outcomes to specific caller agents — Claude Desktop vs. Cursor vs. ChatGPT Apps vs. generic MCP client — over 7-day and 30-day windows.

### Q8: Are you funded?

Bootstrapped. Running on $0 outside revenue. Solo founder + engineer. Full transparency in the report's "About Advocate" section.

### Q9: Do you have customers who will talk on the record?

One paying customer in Q1 (Workman Copy Co), and we can coordinate a conversation with them with permission. The other tenants referenced in the dataset are our own pre-customer pilot installs, which we describe as such in the report — we are not presenting them as customer references.

### Q10: What's the business model?

Flat monthly subscription per business. The free **Business** tier covers agent hosting and attribution. **Pro** adds Competitor Radar (weekly Perplexity citation polling) and per-agent reputation analytics. We do not take a cut of transactions. We do not sell the attribution data. The business owns their tenant data.

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

Two sentences on what's new: we built and validated a closed-loop AI attribution pipeline at SMB tier and captured six end-to-end click events in Q1 validation. One paying customer, N=9 organic queries customer-side, methodology preview before the quantitative Q2 report.

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

# AdvocateMCP — Cloudflare Workers Launchpad Application

**Draft v1 — Apr 16, 2026**
**Target cohort:** Cohort #7 (applications currently open)
**Contact:** Cameron McEwan — `[FILL IN: email]`
**Company:** AdvocateMCP — `[FILL IN: LLC or C-corp status]`
**Website:** advocatemcp.com
**Repository:** private (demo access available on request)

---

## Section 1 — One-line positioning

Five variants, graded from conservative to forward-leaning. Pick one for the application form, reserve the others for follow-up conversations.

1. **AdvocateMCP makes local businesses addressable by AI agents — built entirely on Workers, D1, KV, and Cloudflare for SaaS.**
2. **AdvocateMCP is the business-facing half of the agent economy: the app layer on top of Cloudflare's bot detection and Pay Per Crawl primitives.**
3. **AdvocateMCP turns every small business into an MCP-addressable endpoint at the edge — one Worker, one manifest, zero origin hit.**
4. **We run the world's first edge-native attribution loop for AI-search traffic, shipped as a Workers + D1 + KV SaaS.**
5. **AdvocateMCP is what you deploy on top of AI Crawl Control once detection alone stops being enough.**

Recommended primary: variant 2 (clearest alignment with Matthew Prince's "agentic future" positioning).

---

## Section 2 — Why Cloudflare, not generic cloud (150w)

AdvocateMCP is production-depth on eight Cloudflare primitives. This is not a lift-and-shift story; moving off platform would take 12+ months and rewrite the product's core latency budget.

- **Workers**: bot detection runs at the edge before any origin hit — the `AI_CRAWLERS` user-agent match in the Worker fetch handler is the entire moat of the interception layer.
- **D1**: multi-tenant portal auth, session storage (PBKDF2-SHA256, SHA-256 hashed session tokens), per-tenant ACLs, click-event attribution log.
- **KV (`BUSINESS_MAP`)**: domain-to-slug hot path for tenant routing. Sub-10ms p99.
- **Cloudflare for SaaS**: per-tenant custom hostnames with automatic SSL for `*.hosted.advocatemcp.com` plus paying customer hostnames like `www.workmancopyco.com`.
- **Workers Routes**: per-tenant dispatch patterns. Required in addition to `custom_origin_server` — we learned this the hard way in production on April 14, 2026.
- **Advanced Certificate Manager**: wildcard cert for the hosted subdomain.
- **Pages**: marketing site + customer dashboard.
- **`/.well-known/mcp.json`**: A2A-discoverable manifest served by the Worker, drift-tested against every registered MCP tool.

---

## Section 3 — Strategic alignment with Cloudflare's roadmap (200w)

Cloudflare has spent 2025 and early 2026 building the primitives of the agent economy. The stack we map onto is explicit in public statements:

- **AI Crawl Control** (GA January 29, 2026): the detection and policy layer. AdvocateMCP's per-bot response generation is the app layer that sits on top — we don't replace detection, we make it productive for the site owner.
- **Pay Per Crawl** (private beta, July 2025): the monetization primitive for publishers with scale. The SMB long tail cannot charge per crawl — a plumber doesn't sell training data. They need attribution and lead capture instead. AdvocateMCP is the Pay Per Crawl complement for the 99% of domains too small to meter.
- **Agent Cloud / Dynamic Workers / Project Think** (April 2026): Matthew Prince's stated vision: "We are making Cloudflare the definitive platform for the agentic web." Every business on AdvocateMCP is an MCP endpoint published from a Worker — we are that platform in practice, today, for SMBs.
- **Prince's SMB thesis**: at Web Summit Lisbon (Oct 2025) and in the TIME 100 AI writeup, the consistent argument is that content creators — including small ones — must be paid or surfaced when AI serves their content. AdvocateMCP operationalizes the "surfaced" half for businesses the ad-tech stack has never served well.

Together, Cloudflare + AdvocateMCP = full SMB AI-attribution loop. No other partner in the ecosystem covers both halves.

---

## Section 4 — Traction and current state (100w)

Honest numbers as of April 16, 2026:

- **4 paying customers**: Workman Copy Co. (routed end-to-end April 14 on CF SaaS custom hostname), Bamboo Brace, Austin Ace Plumbing, plus one seed demo tenant.
- **$0 paid marketing spend** to date. All organic.
- **6 MCP tools live on the central `/mcp` endpoint**: `search_businesses`, `query_business_agent`, `get_availability`, `get_quote`, `reserve_slot`, `initiate_handoff`. 432/432 tests passing.
- **9 PRs merged in the last 24 hours**. 18 production deploys in the last 30 days.
- **Per-agent reputation + rate-limit tiers** (unverified / known / trusted) shipped this week; agent-aware prompt tuning shipped the same week.
- **Competitor Radar** (Perplexity citation tracking) live for Pro tier.
- **ChatGPT Apps SDK submission** planned this week.

---

## Section 5 — What we need from Cloudflare (100w)

Four specific asks, ranked:

1. **Workers credits up to $250K** to absorb the MCP tool-call volume when ChatGPT Apps SDK distribution lands. Current run rate is low; projected 10-50x growth in 90 days.
2. **BD introduction to the Agents product team** (Dane Knecht's org / the Project Think and Dynamic Workers leads). We want co-positioning, not just co-marketing — specifically: reference implementation status for "MCP-over-Workers for multi-tenant SaaS."
3. **Flagship case study slot** at the next CF Connect or Birthday Week. Our story — edge bot detection + MCP at the edge + attribution loop — is a ready-made demo for CF's own agent narrative.
4. **Inclusion in the "Cloudflare's own MCP servers" developer docs** as the canonical third-party multi-tenant example.

---

## Section 6 — Why now (75w)

The window is 9 to 15 months. Scrunch's AXP product (announced Q1 2026) is the nearest competing attempt at edge interception; Profound, Peec, and Otterly are converging toward the same category from the static-monitoring side. If Cloudflare ships a native "AI answer worker" primitive before a partner ecosystem exists, AdvocateMCP is commoditized. If we lock the Launchpad relationship now, Cloudflare's natural next move is to partner, not build. That is the entire strategic logic of this application.

---

## Section 7 — 12-month milestones if admitted

Tied directly to our internal roadmap. All numbers measurable from Railway + D1.

- **Month 3 (July 2026)**: 50 paying customers. ChatGPT App live and driving at least 30% of new signups. One vertical validated (local trades or legal — to be decided based on CAC signal).
- **Month 6 (Oct 2026)**: $50K MRR. 200+ customers. First "State of AI Bot Traffic" report published — benchmark data from our Workers interception layer, co-promoted with CF if interested. Perplexity + OpenAI + Anthropic all represented in the citation dataset.
- **Month 9 (Jan 2027)**: Series A closed (target $6-10M). First three hires (one platform engineer, one GTM lead, one designer). CF flagship case study published. MCP Registry integration shipped (discoverability beyond our own manifest).
- **Month 12 (Apr 2027)**: $250K MRR. 1,000+ customers. Acquisition conversations opened — ideally CF as the natural acquirer given the platform depth, but the Launchpad relationship is valuable either way.

---

## Appendix A — Technical architecture summary

For the CF Solutions Architecture reviewer.

### Edge (Cloudflare Workers)
- Bot detection via hardcoded `AI_CRAWLERS` UA array (PerplexityBot, GPTBot, OAI-SearchBot, ClaudeBot, Google-Extended, Googlebot, anthropic-ai, cohere-ai, meta-externalagent).
- Domain routing via KV `BUSINESS_MAP`.
- Per-tenant portal with PBKDF2 auth, D1-backed sessions, PII-safe logging.
- Signed-token attribution redirect at `/r/:token` (HMAC-SHA256, identical signing logic on Worker and Railway sides).
- `/.well-known/mcp.json` manifest served at edge.

### Central MCP server (Railway, short-term — migration plan below)
- Node/Express; will migrate incrementally to Workers over the next 6 months once Durable Objects + D1 fit the workload. Current blockers: SQLite-to-D1 migration cost and Claude API streaming latency from workerd.
- 6 MCP tools exposed at `POST /mcp` and `GET /mcp` (SSE + streamable HTTP).
- `claude-sonnet-4-6` with Anthropic prompt caching on the system prompt prefix (profile → intent → bot → agent × stage).

### Storage
- SQLite on Railway for analytics and business data (short-term).
- D1 for edge-side auth, attribution, click events, agent requests.
- KV for hot domain lookup.
- R2 for raw event archival (PII stays here, never hits analytics tables).

### Attribution loop (the moat)
- Every outbound citation URL from a bot response is a signed HMAC-SHA256 tracked redirect.
- Click events logged to D1 with `agent_id` + `request_id` correlation.
- Per-agent reputation rollup (7d and 30d windows) drives rate-limit tiers and informs future prompt weighting.

---

## Appendix B — Differentiation versus adjacent products

| Product | Positioning | What they miss |
|---|---|---|
| Scrunch AXP | Static GEO monitoring + some interception | No multi-tenant MCP layer, no edge-native attribution redirect |
| Profound / Peec / Otterly / Athena HQ | Citation monitoring dashboards | Read-only; no interception; no per-bot response generation |
| Cloudflare AI Crawl Control | Bot detection + Pay Per Crawl | Infrastructure layer; not targeted at SMB attribution |
| Zapier / n8n MCP connectors | Generic MCP bridges to SaaS APIs | Not tuned for bot-side response or attribution — no SMB fit |

AdvocateMCP is the only product combining edge bot interception, per-bot conversational response, signed-token attribution, and multi-tenant MCP publishing in a single Cloudflare-native stack.

---

## Sources

All citations verified via WebSearch on April 16, 2026.

- [Cloudflare Workers Launchpad funding program](https://www.cloudflare.com/startups/workers-launchpad/) — program overview, eligibility, Cohort #7 open status.
- [A lookback at Workers Launchpad and a warm welcome to cohort #6](https://blog.cloudflare.com/workers-launchpad-006/) — cohort benefits, $250K credit ceiling, 145 alumni from 23 countries.
- [Cloudflare acquires Nefeli Networks / Outerbase — cohort alumni](https://blog.cloudflare.com/workers-launchpad-006/) — acquisition precedent for Launchpad alumni.
- [Announcing Cohort #2 of the Workers Launchpad](https://blog.cloudflare.com/launchpad-cohort2/) — program structure and quarterly cadence.
- [Introducing pay per crawl](https://blog.cloudflare.com/introducing-pay-per-crawl/) — July 2025, private beta.
- [The next step for content creators: Introducing AI Crawl Control](https://blog.cloudflare.com/introducing-ai-crawl-control/) — rebrand from AI Audit.
- [AI Crawl Control — Pay Per Crawl private beta changelog](https://community.cloudflare.com/t/ai-crawl-control-pay-per-crawl-private-beta-discovery-api-custom-pricing-and-advanced-configuration/867276) — discovery API + custom pricing.
- [Cloudflare AI Crawl Control docs](https://developers.cloudflare.com/ai-crawl-control/) — GA documentation.
- [Cloudflare Expands its Agent Cloud press release, April 2026](https://www.cloudflare.com/press/press-releases/2026/cloudflare-expands-its-agent-cloud-to-power-the-next-generation-of-agents/) — Dynamic Workers, Project Think, Agents SDK.
- [Cloudflare expands Agent Cloud — SiliconANGLE coverage](https://siliconangle.com/2026/04/13/cloudflare-expands-agent-cloud-new-tools-build-scale-ai-agents/) — Prince quote "definitive platform for the agentic web."
- [Project Think: building the next generation of AI agents on Cloudflare](https://blog.cloudflare.com/project-think/) — long-running agents framework.
- [Cloudflare's AI Platform: an inference layer designed for agents](https://blog.cloudflare.com/ai-platform/) — inference positioning.
- [Build and deploy Remote Model Context Protocol (MCP) servers to Cloudflare](https://blog.cloudflare.com/remote-model-context-protocol-servers-mcp/) — remote MCP primitives.
- [Model Context Protocol on Cloudflare Agents docs](https://developers.cloudflare.com/agents/model-context-protocol/) — McpAgent class, workers-oauth-provider.
- [Cloudflare's own MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/) — docs page we want inclusion in.
- [Code Mode: the better way to use MCP](https://blog.cloudflare.com/code-mode/) — V8 isolates for MCP sandboxing.
- [TIME 100 AI 2025 — Matthew Prince](https://time.com/collections/time100-ai-2025/7305834/matthew-prince/) — public positioning.
- [Cloudflare CEO Matthew Prince: AI bots could surpass human web traffic by 2027](https://www.thekeyexecutives.com/2026/04/07/cloudflare-ceo-matthew-prince-says-ai-bots-could-surpass-human-web-traffic-by-2027/) — market sizing argument.
- [Matthew Prince's plan to get AI oligarchs to pay for content](https://crazystupidtech.com/2025/08/30/cloudflares-ceo-wants-to-save-the-web-from-ais-oligarchs-heres-why-his-plan-isnt-crazy/) — publisher compensation thesis (250:1 OpenAI, 6000:1 Anthropic crawl-to-referral ratios).
- [Prince at Web Summit Lisbon on Google and search abuse](https://techcrunch.com/2025/10/21/cloudflare-ceo-matthew-prince-is-pushing-uk-regulator-to-unbundle-googles-search-and-ai-crawlers/) — regulatory pressure narrative.
- [Nieman Lab — Cloudflare blocks AI scrapers by default](https://www.niemanlab.org/2025/07/cloudflare-will-block-ai-scraping-by-default-and-launches-new-pay-per-crawl-marketplace/) — default-block behavior.

---

## Open questions for Cameron

Fill these in before submission. None of these block drafting, but all of them must be resolved before the application goes in.

1. **Contact email + LLC/C-corp status.** The application form will ask for legal entity type and primary contact. Current guess: you are operating as an LLC with no outside funding; confirm or correct.
2. **Funding stage to disclose.** Launchpad accepts up to Series B. If you are pre-seed / bootstrapped, say that explicitly — there's no penalty. If you have taken any angel money or SAFE notes, mention it.
3. **Named Series A target investors.** The application asks for VC relationships. Do you already have introductions (Haystack, Bessemer, Uncork, Accel — any of CF's announced Launchpad partners)? If yes, name-drop. If no, say "we would welcome introductions from the Launchpad VC network" — that is actually a stronger signal.
4. **Exact MRR number.** We wrote "4 paying customers" but did not write MRR. Confirm the real number so we can include it (or decline to include it — both are fine; vague is worse than absent).
5. **Customer logo rights.** Can we name-drop Workman Copy Co, Bamboo Brace, Austin Ace Plumbing publicly in the application? If any of them have not given written permission, we should redact.
6. **Team size and background.** The application will ask. Solo founder? Any contractors? Prior CF / AI / SaaS experience to highlight?
7. **OpenAI reviewer demo status.** We listed it as a "seed" customer. Is this a real billed account or a comped demo? Launchpad reviewers are sharp; inflating traction is disqualifying. Recommend we drop it from the customer count and mention separately as "in pipeline."
8. **Demo URL + credentials for the CF reviewer.** Need a live demo endpoint or a recorded walkthrough. The manifest at `/.well-known/mcp.json` on production is a strong artifact; do we want to include a direct link?
9. **State of AI Bot Traffic report commitment.** Month 6 milestone claims we publish this. Are you willing to commit to that if admitted? It is a credible co-marketing asset with CF but it is also ~3-4 weeks of real work.
10. **Acquisition framing.** Section 7 mentions "acquisition conversations" at month 12. Are you comfortable with CF reading that as a hint? If you would rather stay independent through Series B, we can soften the language to "strategic partnership discussions."
11. **Worker migration commitment timeline.** Appendix A notes the central MCP server is on Railway today with a 6-month migration-to-Workers plan. Do we want to commit to that timeline in the application (strong CF alignment signal) or leave it softer?

---

## Reviewer checklist (internal — remove before submission)

- [ ] All open questions resolved
- [ ] MRR number inserted or explicitly omitted
- [ ] Customer logos confirmed
- [ ] Contact + entity info filled in
- [ ] Demo URL validated
- [ ] One-line positioning variant selected
- [ ] Length under 3000 words (currently ~2600)
- [ ] Sources re-verified day of submission (CF doc URLs change)

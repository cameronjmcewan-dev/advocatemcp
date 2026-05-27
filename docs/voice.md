# Voice & Copy Style Guide

This guide governs user-facing copy in the AdvocateMCP dashboard. Our audience
is a small-business owner — often non-technical, often 60+ — who wants to
understand whether AI search is helping their business. They do not know what
JSON-LD is, what a webhook does, or why "engine scores" matter.

When in doubt: write what your customer would say out loud, then trim.

---

## 1. Voice principles

1. **Plain English first.** If a term needs a glossary entry, paraphrase it
   inline instead.
2. **Verbs over nouns.** "Tells AI search engines where to find you" beats
   "Provides AI engine discoverability." Verbs read faster.
3. **Expand acronyms on first mention per page.** "Google Search Console (GSC)"
   once, "GSC" afterwards.
4. **Name what's happening, not the internal term.** "Connected services"
   beats "Connected agents." "Booking notifications" beats "Webhooks."
5. **Lead every metric page with an "In plain English:" banner.** A 1-2
   sentence intro that says what the page measures and (where useful) what it
   doesn't, in conversational language.
6. **Action buttons start with a verb.** "Connect Google Analytics" not
   "Google Analytics integration."
7. **No emojis in copy unless the user explicitly requests them.**
8. **No exclamation points outside genuine empty-states.** "No data yet —
   connect a tool below!" is fine. "Welcome!" is not.

---

## 2. Forbidden words & replacements

These apply to **user-facing strings only**. Code identifiers (e.g.
`availability_webhook_url`), API contract field names, JSON payload keys, and
internal comments are not affected — they are not what the user sees.

| Forbidden (user-facing) | Replacement |
|---|---|
| `citation_rate`, `cite_rate`, `cite rate`, `citation score` | "how often AI search names you" |
| `crawler`, `bot fetch`, `server-side bot fetches`, `bot variant` | "AI search engine" or "AI tool" |
| `agent` (in product context, user-facing) | "your AI listing" or "your Advocate profile" |
| `connected agents` | "your connected integrations" |
| bare `GA4` (first mention) | "Google Analytics 4 (GA4)" |
| bare `GSC` (first mention) | "Google Search Console (GSC)" |
| bare `MCP` (first mention) | "the AI plugin protocol (MCP)" |
| bare `CRM` (first mention) | "your CRM (HubSpot or Salesforce)" |
| bare `AOV` (first mention) | "average order value (AOV)" |
| `webhook` (without context) | "automatic notification" or "booking-system connection" |
| `attribution` (raw) | "how we link a visit to a sale" |
| `intent` (raw category label) | rephrase to the question type |
| `poll`, `polls` (Advocate-specific) | "weekly AI search test" |
| `JSON-LD`, `schema.org`, `structured data` | "the structured info AI engines read" |
| `per-engine`, `per-variant`, `per_*` | "for each AI tool" |
| `engine scores` | "AI visibility scores" |
| `share of voice`, `voice share` | "how often you get named vs. competitors" |
| `win rate`, `loss tracking` | "how often you get named" |
| `hype-flagged` | "flagged as too promotional" |
| `verbatim social proof` | "real customer quotes" |
| `keyword authority gap` | "topic where competitors are winning" |
| `cite rate (in AI Overview)` | "how often Google's AI Overview links to you" |
| `AI Overview presence rate` | "how often Google's AI Overview shows your site" |

If a phrase needs to appear once for technical accuracy (e.g. naming a
specific Google API), pair it with the plain-English version: *"Google Search
Console (the same site-verification tool you use for SEO)."*

---

## 3. Required patterns

### 3.1 "In plain English:" banner

Every metric page MUST open with a short banner explaining what the page
measures and (if relevant) what it doesn't.

```html
<div class="plain-banner">
  <strong>In plain English:</strong>
  1–2 sentences here. Conversational. Names the thing in customer words.
</div>
```

Existing anchors to mirror:
- `mentions.js:274–276` — *"Every time an AI assistant brought up your business,
  we log it here — who mentioned you, what the person was asking, and whether
  they then clicked through."*
- `radar.js:205–208` — *"Every week we ask the major AI tools the questions
  your customers would ask, and log whether you or a competitor got named."*

### 3.2 Metric card subtitles

Every KPI card and chart needs a one-line subtitle that defines the metric.
The subtitle answers "what does this number mean?" in plain language.

Bad:
```html
<div class="k">Engagement rate</div>
<div class="v">42%</div>
```

Good:
```html
<div class="k">Engagement rate</div>
<div class="v">42%</div>
<div class="d">Share of visits where someone scrolled, clicked, or stayed past 10 seconds</div>
```

### 3.3 First-mention acronym expansion

The first time an acronym appears on a page, expand it. After that the
acronym alone is fine.

Bad: *"Connect GSC to track AI Overview cite rate."*
Good: *"Connect Google Search Console (GSC) to track how often Google's AI
Overview links to your site."*

### 3.4 Action button labels

Action buttons start with a verb. The verb names what the user is about to do.

Bad: "Google Analytics integration"
Good: "Connect Google Analytics"

Bad: "API credentials"
Good: "Rotate API key"

---

## 4. Examples — good and bad

| ❌ Don't | ✅ Do |
|---|---|
| "Counts server-side bot fetches from AI engines (ClaudeBot, GPTBot, PerplexityBot)" | "Counts how often AI search engines (Claude, ChatGPT, Perplexity) fetched your page" |
| "Citation rating" | "How often AI search names you" |
| "AI Overview cite rate" | "How often Google's AI Overview links to your site" |
| "Connected agents" | "Your connected integrations" |
| "Programmatic access for your own code" | "API access for developers integrating with Advocate" |
| "Per-engine breakdown shows how the rendered-for-Perplexity variant scores" | "We score the version of your page that each AI tool actually sees" |
| "Track AI Overview presence and cite rate for your top queries" | "Track how often Google's AI Overview shows your site for your top searches" |
| "Hype-flagged differentiator copy" | "Differentiator copy flagged as too promotional" |
| "Engine scores" | "AI visibility scores" |
| "Webhook URL" (as a label on a customer field) | "Booking-system notification URL" |

---

## 5. Maintenance

- **Adding a new metric or page?** Start with an "In plain English:" banner
  and metric subtitles. Mirror `mentions.js` or `radar.js` voice.
- **Tempted to use a new technical term?** Add it to §2 with a plain-English
  replacement, *or* paraphrase it inline.
- **Catching jargon in CI:** `worker/src/voiceContract.test.ts` runs a
  static-grep against the six dashboard pages and fails if forbidden
  user-facing copy reappears. If a legitimate use surfaces (e.g. a label
  inside a `<code>` block showing the customer their API key), narrow the
  allow-list rather than weakening the test.
- **Forbidden-list drift:** review this guide once per quarter, or whenever
  a new integration introduces vocabulary the audience doesn't share.

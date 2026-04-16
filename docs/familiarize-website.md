# Familiarize: AdvocateMCP Website

A comprehensive guide to the AdvocateMCP marketing site and customer-facing web application hosted on Cloudflare Pages.

---

## Overview

The AdvocateMCP website (`advocatemcp.com`) is a static HTML/CSS/JS site deployed via **Cloudflare Pages** (project: `advocatemcp-site`, source: `site/` directory). It serves the marketing landing page, customer onboarding flow, login, domain activation, and the authenticated dashboard — all built with **vanilla HTML, CSS, and JavaScript** (no React, no build step).

> ⚠️ Pages deploys are NOT git-connected. Running `wrangler pages deploy site/` from a directory missing files will wipe those files from production.

---

## File Inventory

| File | Lines | Purpose |
|------|-------|---------|
| `site/index.html` | ~2,007 | Marketing landing page |
| `site/dashboard.html` | ~1,169 | Authenticated user dashboard |
| `site/onboarding.html` | ~1,023 | Multi-step signup and plan selection |
| `site/onboarding/complete.html` | ~363 | Post-Stripe-checkout confirmation |
| `site/activate.html` | ~313 | Domain activation (DNS records) |
| `site/login.html` | ~245 | Customer login form |
| `site/js/*.js` (14 modules) | ~154 KB total | Dashboard section logic, auth, UI primitives |

---

## Page-by-Page Walkthrough

### 1. Marketing Landing Page — `index.html`

**Title:** "Advocate — Get recommended by every AI, automatically"

The primary conversion page. Explains the product, showcases features, provides social proof, and drives signups.

**Key sections (top to bottom):**

| Section | Description |
|---------|-------------|
| **Sticky Nav** | Links to Features, Industries, Pricing, Dashboard. "Get Started" CTA. Theme toggle (dark/light). Mobile hamburger. |
| **Hero** | Value prop: "Get found by AI, not buried by it." Browser mockup showing a Perplexity-style AI answer. Live platform indicators (Claude, ChatGPT, Perplexity, Gemini, Bing AI). |
| **Ticker** | Scrolling marquee of supported AI platform logos. |
| **Features** | Alternating 2-column rows: business profiles, domain routing, referral tracking, competitor radar, recommendation engine. |
| **Capabilities** | 3-column grid: structured profiles, real-time analytics, custom domain routing. |
| **Trust Band** | 3-column: flat pricing, easy setup, real-time data. |
| **Industries (Tabbed)** | Tabs for Real Estate, Legal Services, Home Services — each with example screenshots and expected metrics. |
| **Case Studies** | Horizontal-scroll carousel of business case studies with industry tags, location, and metrics. |
| **Pricing** | Two tiers: Starter ($49/mo) and Pro ($149/mo). |
| **Final CTA** | "Your competitors will be on AI. Will you?" |
| **Footer** | 4-column layout with product links, company links, legal links, newsletter signup, and social icons. |

> ⚠️ The pricing shown on this page ($49/$149) does not match the actual Stripe prices ($100/$250). This is a known artifact — do not "fix" it to match the HTML.

**CTAs:** All "Get Started" buttons link to `/onboarding.html`.

---

### 2. Onboarding — `onboarding.html`

**Title:** "Set Up Your Profile — Advocate"

Multi-step form that walks new customers through business profile creation and plan selection.

**Steps:**
1. **Basic info** — Business name, location, category
2. **Profile details** — Description, services, hours
3. **Plan selection** — Redirects to Stripe checkout
4. **Review** — Summary of all entered data
5. **Success** — Redirects to activation or dashboard

**Progress indicator:** 4–5 dot steps connected by a visual line at the top.

**Form controls used:** Text inputs, textareas, toggles, radio buttons, review summary.

**Error handling:** Field-level red borders + error messages; inline error banners.

> ⚠️ Known issue: `onboarding.html` currently posts to `https://advocate-production-2887.up.railway.app/api/businesses` which does NOT exist on Railway. Should be wired to the worker's `/api/onboard/public`.

---

### 3. Post-Checkout Confirmation — `onboarding/complete.html`

**Title:** "Setting up your account — Advocate"

Polls Stripe webhook status after checkout completion.

**Flow:**
1. Reads `?session_id=` from URL
2. Polls `/api/onboard/session/:session_id` every 3 seconds (max 20 attempts / 60 seconds)
3. Displays plan type and tenant slug on success
4. Degrades to "pending" if webhook is slow — allows login anyway

**States:** No session → Loading → Success → Pending → Error (contact support).

---

### 4. Login — `login.html`

**Title:** "Sign in — Advocate"

Focused login card (400px wide, centered).

**Form fields:** Email, password, submit.

**Logic:**
- Client-side validation (non-empty)
- Calls `window.AMCP.login()` (from `dashboard-auth.js`)
- Redirects to `/dashboard.html` on success
- Auto-redirects if refresh token still valid (skips login)

**Error messages:** `invalid_credentials`, `rate_limited`, `platform_error`, `invalid_body`.

**CTA:** "Need an account? Get started →" links to `/onboarding.html`.

---

### 5. Domain Activation — `activate.html`

**Title:** "Activate your domain — Advocate"

Post-purchase flow for customers to configure their domain's DNS.

**Flow:**
1. Customer receives email with link: `/activate.html?t=<signed_token>`
2. Enters domain (e.g. `yourbusiness.com`)
3. System verifies and returns DNS records (A, CNAME, MX)
4. Customer adds records at their registrar
5. Once DNS propagates, can sign in to dashboard

**States:** No token → Enter domain → Loading → DNS records displayed → Error → Pending.

---

### 6. Dashboard — `dashboard.html`

**Title:** "Dashboard — Advocate"

Authenticated single-page app with sidebar navigation and tabbed content areas.

**Layout:** 240px fixed sidebar + flexible main content area (full viewport height).

**Navigation sections:**

| Section | Module | Description |
|---------|--------|-------------|
| Overview | `dashboard-overview.js` | KPI cards with sparklines, count-up animations, 15-day deltas, data-driven insights |
| AI Requests | `dashboard-requests.js` | Trend chart, top queries table, intent distribution, response detail drawer |
| Bot Activity | `dashboard-bots.js` | Crawler table, intent bars, 7×24 UTC/Local heatmap, tooltips |
| Referral Clicks | `dashboard-clicks.js` | Click event trend chart, top sources, intent distribution |
| Recommendations | `dashboard-recs.js` | Dynamic recommendation cards + checklist from API |
| Domains | `dashboard-domains.js` | CF SaaS hostname, SSL status, Worker Route status, "Test bot traffic" button, API key rotation |
| Competitor Radar | `dashboard-radar.js` | Pro-only: competitor presence tracking, poll frequency, basket CRUD |
| Settings | `dashboard-settings.js` | Plan badge, email, API key, profile form, activity card |
| Activity | `dashboard-activity.js` | Reservations, handoffs, agent reputation, radar polls, detail drawers |
| Admin | `dashboard-admin.js` | Admin god-mode: business switcher, aggregate overview, filters/sorting, alert pills |

**Responsive:** Sidebar collapses to bottom tab bar on mobile. Grid layouts collapse to single column.

---

## JavaScript Modules (`site/js/`)

All modules are **IIFEs** that register on `window.AMCP_SECTIONS` or expose helpers via `window.AMCP_*`.

| Module | Purpose |
|--------|---------|
| `dashboard-auth.js` | Shared auth API: login, logout, token refresh. HttpOnly refresh cookies. No localStorage for tokens. |
| `dashboard-ui.js` | Shared UI primitives: sparkline, countUp, deltaChip, toast, drawer/modal system. |
| `dashboard-theme.js` | Theme helper: exposes `window.AMCP_THEME.accent()` so modules read accent color from CSS `:root`. |
| `dashboard-overview.js` | Overview KPIs, sparklines, deltas, insights. |
| `dashboard-requests.js` | AI requests trend chart, query table, response drawer. |
| `dashboard-bots.js` | Bot activity table, heatmap, tooltips. |
| `dashboard-clicks.js` | Referral click trends, top sources. |
| `dashboard-recs.js` | Recommendation cards and checklists. |
| `dashboard-domains.js` | Domain status, DNS management, API key rotation. |
| `dashboard-radar.js` | Competitor radar (Pro-only), basket management. |
| `dashboard-settings.js` | Account info, profile form, activity card. |
| `dashboard-activity.js` | Reservations, handoffs, agent reputation, detail drawers. |
| `dashboard-admin.js` | Admin aggregate overview, business switcher, alerts. |
| `dashboard-activate.js` | Domain activation logic for `activate.html`. |

**Key patterns:**
- **Window namespacing:** `AMCP_SECTIONS`, `AMCP_DATA`, `AMCP_UI`, `AMCP_THEME`, `AMCP_ADMIN`
- **No frameworks:** Pure vanilla JS with Chart.js and Lucide icons as the only external deps
- **Single drawer:** All modals/drawers share one DOM element
- **Single toast stack:** All notifications queue through one container
- **API base:** All fetches go to `https://customers.advocatemcp.com/api/*`

---

## Design System

### Color Palette (Dark Theme — Default)

| Token | Value | Usage |
|-------|-------|-------|
| `--bg` | `#171614` | Page background |
| `--surface` | `#1c1b19` | Card/panel background |
| `--surface-2` | `#222120` | Hover/secondary surface |
| `--border` | `#393836` | Borders |
| `--text` | `#e8e6e3` | Body text |
| `--muted` | `#7a7875` | Secondary text, labels |
| `--accent` | `#7d2550` | Brand mauve (primary accent) |
| `--accent-dk` | `#5c1a3c` | Darker accent (hover states) |
| `--accent-dim` | `rgba(125,37,80,.12)` | Light accent backgrounds |
| `--accent-ring` | `rgba(125,37,80,.25)` | Accent outlines/rings |
| `--green` | `#3fb950` | Success, positive |
| `--yellow` | `#d29922` | Warning |
| `--red` | `#f85149` | Error, danger |

Light theme: `[data-theme="light"]` overrides all tokens (bg → `#f5f4f2`, accent → `#01696f`, etc.).

### Typography

| Role | Font | Source |
|------|------|--------|
| Headings/display | Instrument Serif | Google Fonts |
| Body/UI | General Sans | Fontshare (api.fontshare.com) |
| Code/DNS records | SF Mono, Fira Code | System fallback |

Fluid scaling with `clamp()` for responsive type sizes. Weights: 400, 500, 600.

### Spacing & Borders

| Token | Value |
|-------|-------|
| `--r-sm` | 4px |
| `--r-md` | 8px |
| `--r-lg` | 12px |
| `--r-xl` | 16px |

### Animations

- **Transitions:** 150ms for color/background/border changes
- **Fade-in:** Scroll-triggered `.fade-up` (opacity + translateY)
- **Hover lift:** `translateY(-4px)` on cards
- **Spinners:** SVG-based, 32px, 0.7s rotation
- **Pulse:** 2s breathing on status dots

### External Dependencies

| Library | Version | CDN | Used For |
|---------|---------|-----|----------|
| Lucide | latest | unpkg | Icons throughout site |
| Chart.js | 4.4.1 | CDN | Dashboard charts |
| General Sans | — | Fontshare | Body font |
| Instrument Serif | — | Google Fonts | Heading font |

---

## User Journey (Navigation Flow)

```
index.html (marketing)
  └─ "Get Started" → onboarding.html (signup form)
      └─ Plan selection → Stripe checkout (external)
          └─ Redirect → onboarding/complete.html (webhook poll)
              └─ "Sign in" → login.html
                  └─ Success → dashboard.html (authenticated app)

activate.html (email link with ?t=token)
  └─ Enter domain → DNS records displayed
      └─ Configure DNS → login.html → dashboard.html
```

---

## API Endpoints Referenced by Frontend

| Endpoint | Used By | Purpose |
|----------|---------|---------|
| `/api/auth/refresh` | dashboard-auth.js | Token refresh |
| `/api/auth/logout` | dashboard-auth.js | Logout |
| `/api/client/me` | dashboard-auth.js | Current user info |
| `/api/client/data` | dashboard-overview.js | Dashboard metrics |
| `/api/client/clicks` | dashboard-clicks.js | Click events |
| `/api/client/domain-info` | dashboard-domains.js | Domain status |
| `/api/client/domain-test` | dashboard-domains.js | Test bot traffic |
| `/api/client/recommendations` | dashboard-recs.js | Recommendation cards |
| `/api/client/radar` | dashboard-radar.js | Competitor radar data |
| `/api/onboard/session/:id` | complete.html | Webhook status polling |
| `/api/activate` | activate.html | Domain activation |
| `/agents/:slug/profile` | dashboard-settings.js | Business profile |

All API calls are made to the Worker at `https://customers.advocatemcp.com`.

---

## Known Issues

| Issue | Details |
|-------|---------|
| **Pricing mismatch** | `index.html` shows $49/$149; actual Stripe prices are $100/$250. Known artifact — do not align to HTML. |
| **Onboarding endpoint** | `onboarding.html` posts to a Railway URL that doesn't exist. Should target `/api/onboard/public` on the worker. |
| **Dashboard redirect** | `customers.advocatemcp.com/dashboard` returns empty body instead of redirecting to the Pages-hosted dashboard. |
| **complete.html** | Was lost in a Pages deploy; needs rebuild/redeploy. |

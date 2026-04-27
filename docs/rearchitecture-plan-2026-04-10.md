# AdvocateMCP Rearchitecture Plan — 2026-04-10

**Status**: Planning document. Read-only. Not yet committed. Produced after the Phase 3 spine shipped and the architecture audit revealed the structural gaps between the current marketing funnel and a working self-serve onboarding flow. This document is the spec for several sessions of subsequent execution work.

---

## Section 0 — Design brief (verbatim)

> The target architecture is `advocatemcp.com` as the single customer-facing hostname for the entire product (marketing, signup, payment, login, dashboard, domain activation, settings, support, billing). `customers.advocatemcp.com` becomes a pure backend hostname serving bot routing, JSON APIs, Stripe webhook, and admin tooling only. No HTML pages served from the worker to customers.

> The design language is the current `advocatemcp.com` brand identity as it exists in the `site/` folder today. Colors, fonts, design tokens, visual identity are canonical and not being rebranded. The rearchitecture applies this existing design system consistently to every customer-facing page, including the new dashboard and the new login page.

> The structural and layout inspiration comes from conduit.ai — Cameron has looked at conduit.ai and wants its information architecture, page structure, and layout patterns (dashboard sidebar, navigation structure, page composition) applied to AdvocateMCP's customer-facing surfaces. Claude Code does not need to read conduit.ai; it cannot access external websites during this audit. Layout decisions during execution will be proposed by Claude Code and compared against Cameron's mental reference of conduit.ai with normal propose-then-approve discipline.

**This means the work is**: (1) extract the existing `advocatemcp.com` design system accurately and treat it as authoritative, (2) propose layouts inspired by conduit.ai's patterns, (3) implement those layouts using the extracted design tokens.

**One important finding that reframes this brief**: the existing `site/index.html` already contains a comment on line 115 — `/* LANDING — Conduit-style redesign */` — and the file already contains a fully mocked-up dashboard at `#page-dashboard` with a conduit-style sidebar, topbar, KPI grid, card rows, data tables, and modals, all styled with the brand tokens. The "conduit.ai inspiration" is already embodied as a reference mockup inside the marketing site. The rearchitecture does not need to invent conduit-style layouts from scratch — it needs to extract them from `#page-dashboard` in `site/index.html` and make them real by wiring them to the actual API.

---

## Section 1 — Current state of the marketing site

### File inventory

Exactly **six HTML files** and two directories in `site/`, no JavaScript files, no CSS files, no config files, no `package.json`, no `node_modules`, no build artifacts:

```
site/
├── index.html               2007 lines   Marketing home + embedded dashboard mockup
├── onboarding.html          1157 lines   5-step self-serve wizard
├── onboarding/
│   └── complete.html         346 lines   Post-Stripe polling / success landing
├── terms.html                291 lines   Static legal page
├── privacy.html              304 lines   Static legal page
└── dpa.html                  332 lines   Static legal page (Data Processing Addendum)
```

Total: 4437 lines of HTML across six files.

### Tooling stack — definitive identification

**Pure static HTML.** No framework. No build step. No preprocessor. No component system. Every file is self-contained — each one inlines its own `<style>` block (duplicated tokens across `index.html`, `onboarding.html`, `complete.html`), inlines its own JavaScript, and loads its own external assets directly from CDNs. Confirmed by:

- No `package.json` anywhere in `site/` or at the repo root.
- No `vite.config.*`, `astro.config.*`, `next.config.*`, `svelte.config.*`, `nuxt.config.*`, `webpack.config.*`.
- No `netlify.toml`, `vercel.json`, `wrangler.toml` inside `site/`.
- No `src/` directory structure, no component files, no `.vue`/`.svelte`/`.jsx`/`.tsx`/`.astro` files.
- No `.gitignore` inside `site/`. The directory is untracked in git at the repo root level.

**External dependencies loaded via `<link>` and `<script>` tags**:

- **Fontshare** (`https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600`) — General Sans typeface, weights 400/500/600.
- **Google Fonts** (`https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1`) — Instrument Serif, upright + italic.
- **Lucide** (`https://unpkg.com/lucide@latest/dist/umd/lucide.min.js`) — icon library. Used via `data-lucide` attributes with a global `lucide.createIcons()` call.
- **Chart.js** (`https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js`) — charting. Used in the embedded dashboard mockup.

No bundling, no tree-shaking, no minification, no versioning strategy beyond the CDN URLs themselves. Everything the customer sees is a single HTTP round-trip per page plus four third-party requests for fonts, icons, and charts.

### Deployment pipeline — definitive identification

**The worker at `customers.advocatemcp.com` does NOT serve these files.** `worker/wrangler.toml` has exactly one route pattern (`customers.advocatemcp.com/*`). There is no static asset binding, no `assets = {...}` configuration, no `[[routes]]` entry for `advocatemcp.com`, no worker handler that reads from `site/`. The deployment pipeline for the marketing site is **entirely external to this repo** — either Cloudflare Pages pointed at a separate source (possibly a separate GitHub repo or a specific path in this one), Netlify, Vercel, or a plain object-storage origin. We cannot determine which from reading this repo alone.

**Consequence**: any change to `site/` files requires an out-of-repo deploy. This is a cross-repo coordination concern for the rearchitecture — the new dashboard and login pages, if they ship to `advocatemcp.com`, have to land in whichever pipeline currently serves the marketing site, which we don't have direct visibility into from inside this repo.

### Build and dev workflow

There is no build and no local dev workflow detectable from `site/` alone. Changes are made by editing HTML files directly and pushing through the external deploy pipeline. No hot reload, no TypeScript checking, no linting, no automated testing.

---

## Section 2 — Design system extraction

This section is the canonical source of truth for every design decision in the rearchitecture. All values are extracted directly from `site/index.html` lines 23–500, verified against `site/onboarding.html` and `site/onboarding/complete.html`, and confirmed consistent across all three.

### Color palette (dark theme — default)

```
--bg:          #171614    /* page background, warm near-black */
--surface:     #1c1b19    /* cards, nav, modals */
--surface-2:   #222120    /* hover states, secondary surfaces */
--border:      #393836    /* dividers, card borders */
--text:        #e8e6e3    /* primary text, warm off-white */
--muted:       #7a7875    /* secondary text, captions */

--accent:      #4f98a3    /* teal — brand primary */
--accent-dk:   #3d8090    /* darker teal — hover states */
--accent-dim:  rgba(79,152,163,.1)    /* 10% tinted background for accent zones */
--accent-ring: rgba(79,152,163,.2)    /* 20% tinted for borders/rings */

--green:       #3fb950    /* success */
--yellow:      #d29922    /* warning */
--red:         #f85149    /* danger */
```

### Color palette (light theme — opt-in via `data-theme="light"`)

```
--bg:          #f5f4f2
--surface:     #ffffff
--surface-2:   #efeeed
--border:      #dddbd8
--text:        #1a1917
--muted:       #6b6967
--accent:      #01696f     /* darker teal — adjusted for light-bg contrast */
--accent-dk:   #015861
--accent-dim:  rgba(1,105,111,.08)
--accent-ring: rgba(1,105,111,.2)
```

Note: green/yellow/red are not redefined for light theme in the source; they inherit the dark-mode values. That's a minor inconsistency; not urgent to fix.

### Typography — families

```
--font-serif: 'Instrument Serif', Georgia, serif
--font-body:  'General Sans', 'Inter', system-ui, -apple-system, sans-serif
--font-mono:  'SF Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace
```

- **Instrument Serif** is used exclusively for headings (h1, h2, h3, large metric values, case study metrics, price amounts). It carries the brand's editorial voice.
- **General Sans** is the body font for all prose, forms, nav, buttons. Weights 400/500/600 loaded.
- **SF Mono** (and fallbacks) for code blocks, DNS records, monospace data display.

### Typography — size scale (fluid with `clamp()`)

```
--tx-xs:   clamp(.6875rem, .66rem + .14vw, .75rem)       /* 11–12px */
--tx-sm:   clamp(.8125rem, .78rem + .16vw, .875rem)       /* 13–14px */
--tx-base: clamp(1rem,     .97rem + .15vw, 1.0625rem)     /* 16–17px */
--tx-md:   clamp(1.0625rem,1.02rem + .21vw, 1.125rem)     /* 17–18px */
--tx-lg:   clamp(1.125rem, 1.07rem + .28vw, 1.25rem)      /* 18–20px */
--tx-xl:   clamp(1.5rem,   1.35rem + .75vw, 2rem)         /* 24–32px */
--tx-2xl:  clamp(2.25rem,  1.9rem + 1.75vw, 3.25rem)      /* 36–52px */
```

### Heading scale (for Instrument Serif display type)

```
--h1: clamp(4rem,   5.5vw, 5rem)       /* 64–80px — hero */
--h2: clamp(2.5rem, 3.5vw, 3rem)       /* 40–48px — section */
--h3: clamp(1.5rem, 1.8vw, 1.75rem)    /* 24–28px — subsection */
```

### Radii

```
--r-sm: 4px    /* buttons, small controls, pill inserts */
--r-md: 8px    /* inputs, medium cards, flow boxes */
--r-lg: 12px   /* large cards, KPI cards, price cards */
--r-xl: 16px   /* browser mockup, pricing cards, modals, hero containers */
```

### Spacing scale (implicit — derived from observed values in the codebase)

The site does not define explicit spacing tokens (no `--sp-1` etc.). Values in use:

- Component gaps: `4px`, `6px`, `8px`, `10px`, `12px`, `14px`, `16px`, `24px`, `32px`
- Section padding: `110px 40px` for major sections (desktop), `60px 20px` (mobile)
- Hero padding: `120px 40px 100px` (desktop), `72px 20px 60px` (mobile)
- Nav: `0 40px` horizontal, `60px` height
- Card internal: `20px` (dashboard), `28px` (case studies), `32px` (modal), `36px 32px` (pricing)
- Content max width: `1100px` (sections), `760px` (hero text), `680px` (pricing), `560px` (hero sub)

For the new dashboard and login pages, these values should be **inventoried and promoted into explicit tokens** during execution — the canonical list above is a good starting point.

### Layout primitives

```
--sidebar-w: 240px   /* dashboard sidebar width */
```

Nav height: `60px` (sticky, `backdrop-filter: blur(14px)`, `rgba(23,22,20,.82)` background).

### Shadow values (implicit, used inline)

- Browser mockup: `0 32px 80px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.04)`
- Card hover: `0 16px 48px rgba(0,0,0,.35)`
- Lift hover: `0 24px 64px rgba(0,0,0,.5), 0 0 0 1px var(--accent-ring)`
- Pricing hover: `0 16px 40px rgba(0,0,0,.3)`

These should be promoted into `--shadow-sm`, `--shadow-md`, `--shadow-lg`, `--shadow-hover` tokens during execution.

### Transition timing

```
all-purpose: .15s    /* buttons, hover states, borders */
fade-up:      .4s ease   /* scroll-triggered animations */
card hover:   .2s ease   /* lift + shadow transitions */
```

### Copy-paste CSS custom properties block

For any new stylesheet in the rearchitecture, the canonical source of truth is this block (dark theme default + light theme override):

```css
:root {
  /* Colors */
  --bg:         #171614;
  --surface:    #1c1b19;
  --surface-2:  #222120;
  --border:     #393836;
  --text:       #e8e6e3;
  --muted:      #7a7875;
  --accent:     #4f98a3;
  --accent-dk:  #3d8090;
  --accent-dim: rgba(79,152,163,.1);
  --accent-ring:rgba(79,152,163,.2);
  --green:      #3fb950;
  --yellow:     #d29922;
  --red:        #f85149;

  /* Typography — families */
  --font-serif: 'Instrument Serif', Georgia, serif;
  --font-body:  'General Sans', 'Inter', system-ui, -apple-system, sans-serif;
  --font-mono:  'SF Mono', 'Fira Code', Consolas, monospace;

  /* Typography — size scale */
  --tx-xs:   clamp(.6875rem, .66rem + .14vw, .75rem);
  --tx-sm:   clamp(.8125rem, .78rem + .16vw, .875rem);
  --tx-base: clamp(1rem,     .97rem + .15vw, 1.0625rem);
  --tx-md:   clamp(1.0625rem,1.02rem + .21vw, 1.125rem);
  --tx-lg:   clamp(1.125rem, 1.07rem + .28vw, 1.25rem);
  --tx-xl:   clamp(1.5rem,   1.35rem + .75vw, 2rem);
  --tx-2xl:  clamp(2.25rem,  1.9rem + 1.75vw, 3.25rem);

  /* Heading scale */
  --h1: clamp(4rem,   5.5vw, 5rem);
  --h2: clamp(2.5rem, 3.5vw, 3rem);
  --h3: clamp(1.5rem, 1.8vw, 1.75rem);

  /* Radii */
  --r-sm: 4px;
  --r-md: 8px;
  --r-lg: 12px;
  --r-xl: 16px;

  /* Layout */
  --sidebar-w: 240px;
}

[data-theme="light"] {
  --bg:         #f5f4f2;
  --surface:    #ffffff;
  --surface-2:  #efeeed;
  --border:     #dddbd8;
  --text:       #1a1917;
  --muted:      #6b6967;
  --accent:     #01696f;
  --accent-dk:  #015861;
  --accent-dim: rgba(1,105,111,.08);
  --accent-ring:rgba(1,105,111,.2);
}
```

Drop this into the top of any new stylesheet as the first rule. Never hardcode hex in downstream styles. Every color reference goes through `var(--...)`.

### Design system drift with the worker

**The worker's current dashboard uses a completely different design system.** `worker/src/routes/dashboard.ts:404-498` defines its own inline tokens (`--bg:#f9fafb; --card:#fff; --text:#111827; --accent:#111827`) with system-font typography only (no General Sans, no Instrument Serif). This is a cool-gray, system-font, near-monochrome aesthetic — not the warm-dark, serif-heading, teal-accented brand identity of the marketing site.

Similarly, `worker/src/routes/sharedLayout.ts` (used by `/onboard`, `/demo`, `/activate`) defines yet another token set using GitHub-dark colors (`#0d1117, #161b22, #238636`) — a third distinct design system.

**The rearchitecture eliminates this drift by having the marketing-site brand tokens be the only design system across the entire customer-facing product.** The worker's dashboard and sharedLayout token blocks become dead code once the dashboard migrates to `advocatemcp.com`.

---

## Section 3 — Component inventory from the marketing site

Every reusable UI component already present in `site/index.html` that the rearchitecture will extend. Each entry lists the source location, the class hook, the visual treatment, and its intended reuse.

### Buttons

- **`.btn`** — base button (`index.html:92-99`). Flex, 10px/20px padding, `--tx-sm` font size, 500 weight, `--r-md` radius, 1px transparent border, three-property transition (background, color, border).
- **`.btn-primary`** — accent background (`--accent` fill, `#fff` text, hover → `--accent-dk`).
- **`.btn-ghost`** — transparent with border (`--border` line, hover → `--surface-2` fill).
- **`.btn-sm`** — smaller variant (7px/14px padding, `--tx-xs` font size). Used in nav CTAs.
- **`.icon-btn`** — square 34×34 icon-only button (`index.html:141-148`). Surface background, border, muted color, hover → text color. Used for nav icons (bell, settings, etc.).

**Gap**: no `.btn-danger` variant in the marketing site. The worker dashboard uses `border:1px solid #fca5a5; color:#dc2626` which is off-brand. A proper `.btn-danger` using `--red` and `--red-dim` (to be added) should be part of the rearchitecture.

### Form inputs

- **`.fi`** (`index.html:698-705`) — modal form input. Full width, 9px/12px padding, `--bg` background (inverts surface inside modals), `--border` 1px, `--r-md` radius, focus → `--accent` border. Used with `.fl` label above.
- **`.ln-newsletter input`** (`index.html:472-478`) — footer newsletter input. Similar treatment but 8px/12px padding and `--surface` background.
- **Onboarding wizard inputs** (in `site/onboarding.html`) — share the same token palette but have slightly different classes (`.input`, `.select`) with their own padding. Should be consolidated with `.fi`.

### Cards

- **`.kpi-card`** (`index.html:586-595`) — dashboard KPI card. `--surface` background, `--border` 1px, `--r-lg` radius, 20px padding. Contains `.kpi-label` (uppercase muted), `.kpi-val` (`--tx-xl` display value), `.kpi-hint` (muted caption).
- **`.db-card`** (`index.html:602-611`) — generic dashboard content card. Same treatment as `.kpi-card` but used for charts, tables, lists.
- **`.ln-mock`** (`index.html:286-313`) — feature-row mockup card with hover lift. Used in the landing page to show miniature UIs.
- **`.ln-case`** (`index.html:398-423`) — customer case study card. 300px fixed width, horizontal scroll container, `--r-xl` radius, 28px padding.
- **`.ln-price-card`** (`index.html:430-453`) — pricing card. `--r-xl` radius, 36px/32px padding, optional `.pop` badge variant.
- **`.card`** (in `site/onboarding.html`) — wizard step container. Similar treatment but with its own class scope.

### Navigation

- **`.ln-nav`** (`index.html:127-135`) — sticky top nav. 60px height, 0/40px padding, `rgba(23,22,20,.82)` semi-transparent background with `backdrop-filter: blur(14px)`, `rgba(255,255,255,.06)` bottom border.
- **`.nav-link`** (`index.html:138-139`) — individual nav item. 6px/14px padding, `--tx-sm`, muted default color, hover → text color + `rgba(255,255,255,.06)` background.
- **`.ln-mobile-menu`** (`index.html:151-157`) — mobile hamburger menu. Fixed positioning, `--bg` background, top-aligned to nav height.
- **`.db-side`** + **`.db-nav`** + **`.db-nav-item`** (`index.html:501-535`) — dashboard sidebar. 240px width, `--surface` background, full-height column layout with logo header, nav list, and footer action. Nav items have hover + active states, the active state uses `--accent-dim` background and `--accent` text.
- **`.db-topbar`** (`index.html:541-571`) — dashboard topbar. 56px height, 0/24px padding, `--bg` background, contains back button, breadcrumb, search input, avatar.

### Step indicators (onboarding)

- **`.step-num`** / **`.ps-1..5`** patterns in `site/onboarding.html` — numbered step circles connected by lines, active/done states with color transitions.
- Referenced again in the worker's `onboardPage.ts` (`.prog-step`, `.prog-line`) with a different class naming convention but similar visual language.

### Data display

- **`table`** + **`th`** + **`td`** (`index.html:634-646`) — dashboard data table. Uppercase muted headers, `--surface-2` header background, hover row highlight.
- **`.badge`** + **`.badge-pend`** / **`.badge-ok`** (`index.html:647-654`) — status pill badges with colored background tints (yellow/green) and a `.badge-dot` inner dot.
- **`.chart-wrap`** (`index.html:612`) — Chart.js container with fixed 168px height.
- **`.activity`** + **`.act-item`** + **`.act-dot`** (`index.html:615-622`) — timeline-style activity list with dot markers.

### Empty states

- **`.empty`** + **`.empty-icon`** + **`.empty-title`** + **`.empty-desc`** (`index.html:665-677`) — centered empty state with icon, heading, muted description. Used when no data is available.

### Modals

- **`.overlay`** + **`.modal`** (`index.html:680-706`) — fade-in modal with 460px max width, `--r-xl` radius, 32px padding, transform-from-below entrance animation.
- **`.fg`** + **`.fl`** + **`.fi`** — form field group, label, input used inside modals.
- **`.modal-foot`** — footer actions (right-aligned button row).

### Footers

- **`.ln-footer`** (`index.html:466-491`) — marketing footer. 56/40/36 padding, 1100px max-width inner, grid with brand column (1.8fr) + three link columns (1fr each), newsletter input, bottom bar with copyright and social icons.

### Misc

- **`.skeleton`** (`index.html:108-113`) — shimmer loading skeleton animation.
- **`.fade-up`** (`index.html:120-124`) — scroll-triggered fade-in transformation. Relies on a MutationObserver or Intersection Observer elsewhere in the file.
- **`.ln-eyebrow`** (`index.html:171-177`) — pill tagline above h1 headings. Uppercase, accent-tinted background, letter-spacing.
- **`.pulse-dot`** (`index.html:202-203`) — pulsing green status dot (live indicator).

### Reuse map

For the new dashboard + login on `advocatemcp.com`, this inventory maps cleanly to what needs to exist:

| Page | Components reused |
|---|---|
| Login | `.btn-primary`, `.fi`, `.fl`, `.fg`, modal-adjacent card layout from `.modal` |
| Dashboard shell | `.db-side`, `.db-nav`, `.db-nav-item`, `.db-topbar`, `.db-back`, `.db-search`, `.db-avatar` |
| Dashboard overview | `.kpi-card`, `.db-card`, `.chart-wrap`, `.activity` |
| Dashboard tables | `table` + `th` + `td`, `.badge`, `.copy-btn` |
| Dashboard settings | `.settings-card`, `.fg`, `.fi`, `.btn-primary`, `.btn-danger` (to be added) |
| Domain activation | `.kpi-card` or `.db-card` container, `.dns-block`, `.dns-type-tag` (already exist for modal-based DNS display) |
| Empty states | `.empty`, `.empty-icon`, `.empty-title`, `.empty-desc` |

Nothing in this reuse map requires inventing new components. Every element already exists in `site/index.html`. The rearchitecture is assembly, not design.

---

## Section 4 — Current state of the worker's customer-facing HTML

Every HTML page currently rendered by the worker that will be affected by the rearchitecture.

| Route | File | Lines | Rendered by | Who reaches it today | Fate |
|---|---|---|---|---|---|
| `GET /onboard` | `worker/src/routes/onboardPage.ts` | 1034 | `handleOnboardPage` | Nobody directly — not linked from marketing site. Dead for customer use because its form POSTs to admin-only `/api/onboard/basic`. | **Delete** after migration. Dead code. |
| `GET /activate` | `worker/src/routes/activatePage.ts` | ~440 | `handleActivatePage` | Post-payment customers via activation token links (future). | **Migrate** to `advocatemcp.com/activate` during Phase D. |
| `GET /login` | `worker/src/routes/portal.ts:107` | ~20 + ~200 HTML in `loginHtml()` | `loginPage` | Portal login — admin-created accounts only. | **Migrate** to `advocatemcp.com/login` during Phase D. |
| `GET /dashboard` | `worker/src/routes/dashboard.ts:182` | 689 | `buildDashboard` | Logged-in customers (via session cookie). | **Migrate** to `advocatemcp.com/dashboard` during Phase D. Completely redesigned on new tokens. |
| `GET /demo`, `GET /demo/:slug` | `worker/src/routes/demo.ts` | ~500 | `handleDemo` | Public — anyone can browse. Used by customers to preview agent responses. | **TBD**. Could stay on worker as a public demo surface, or migrate to `advocatemcp.com/demo`. Defer decision until Phase E. |
| `GET /status` | `worker/src/routes/portal.ts:370` | ~250 HTML in `statusHtml()` | `statusPage` | Public — anyone can view system status. | **TBD**. Migrate or keep. Low priority. |

### Pages on the worker that will be KEPT as-is on `customers.advocatemcp.com`

None of the HTML. After the rearchitecture, zero HTML pages should be served from `customers.advocatemcp.com` to customers. The only HTML the worker serves should be admin surfaces (if any remain) and the `/demo` preview pages if they're kept as a public playground.

### Lines of dead-code removal opportunity

- `worker/src/routes/onboardPage.ts` — 1034 lines
- `worker/src/routes/sharedLayout.ts` — estimate 200+ lines (used by multiple worker HTML pages that all migrate)
- `worker/src/routes/dashboard.ts` — 689 lines (the HTML builder, not the analytics fetch)
- Login HTML inside `portal.ts` — ~200 lines
- Activate HTML inside `activatePage.ts` — ~440 lines

Estimated total: ~2500-2800 lines of worker-side HTML and CSS that becomes obsolete once the `advocatemcp.com` pages are in place. This is a significant simplification of the worker.

---

## Section 5 — Target architecture

### Responsibilities split

**`advocatemcp.com` — single customer-facing hostname:**

- Marketing home (`/`)
- Pricing (`/#pricing` or dedicated `/pricing`)
- Legal pages (`/terms`, `/privacy`, `/dpa`)
- Signup funnel (`/onboarding`)
- Post-payment landing (`/onboarding/complete`)
- Login (`/login`)
- Dashboard (`/dashboard`) — full 6-section analytics and settings
- Domain activation page (`/activate`) — post-payment, token-gated
- Settings (`/settings` — may be a dashboard section)
- Support entry point (`/support` or external)
- Billing (`/billing` — Stripe customer portal link)
- Password reset (future: `/reset-password`)

All of these pages load the brand design tokens. All of them call JSON APIs on `customers.advocatemcp.com` via `fetch` with CORS + credentials handling (see Section 6).

**`customers.advocatemcp.com` — pure backend, no customer HTML:**

- Bot routing: AI crawler hits customer domain → routed by KV → proxied to Railway agent → response wrapped with tracked referral URL
- `/.well-known/ai-agent.json` — AI agent discovery manifest
- `/track` — referral click redirect + logging
- `/mcp` + `/mcp/*` — MCP protocol proxy to Railway
- `/agents/:slug/query` — platform agent endpoint (Phase 1.5 route)
- JSON API for the frontend:
  - `POST /api/auth/login` — email + password → returns session token (new, replaces form-based login)
  - `POST /api/auth/logout`
  - `GET /api/client/me` — current session's user info
  - `GET /api/client/metrics?slug=` — dashboard analytics JSON
  - `GET /api/client/activity?slug=` — recent queries JSON
  - `POST /api/client/rotate-key` — rotate per-business API key
  - `POST /api/onboard/public` — create tenant + Stripe Checkout Session (unchanged, already CORS'd)
  - `GET /api/onboard/session/:session_id` — payment status polling (unchanged)
  - `POST /api/activate` — domain activation (Phase 3, already token-authenticated)
  - `POST /api/stripe/webhook` — Stripe webhook receiver
- Admin API (X-Admin-Secret protected, Cameron tooling only):
  - `POST /admin/create-client`
  - `POST /admin/domains/activate`
  - `POST /admin/activation-token`
  - `GET /admin/domains/:slug/status`
  - `POST /admin/onboard/*` legacy endpoints (TBD whether to keep or delete)

**The seam**: every page on `advocatemcp.com` talks to the worker via `fetch` calls using CORS + cross-origin credentials. The worker talks to Railway as it does today. Cross-origin auth is the most important technical decision (Section 6).

### URL structure

```
advocatemcp.com/                    marketing home
advocatemcp.com/#features           marketing anchor
advocatemcp.com/#pricing            marketing anchor
advocatemcp.com/onboarding          5-step signup wizard (existing)
advocatemcp.com/onboarding/complete post-Stripe landing (existing)
advocatemcp.com/login               NEW — replaces customers.advocatemcp.com/login
advocatemcp.com/dashboard           NEW — replaces customers.advocatemcp.com/dashboard
advocatemcp.com/activate?t=<token>  NEW — moves from customers.advocatemcp.com/activate
advocatemcp.com/settings            NEW (may be a dashboard section)
advocatemcp.com/terms               existing static
advocatemcp.com/privacy             existing static
advocatemcp.com/dpa                 existing static

customers.advocatemcp.com/.well-known/ai-agent.json
customers.advocatemcp.com/track
customers.advocatemcp.com/mcp
customers.advocatemcp.com/agents/:slug/query
customers.advocatemcp.com/api/*     JSON APIs (all of them)
customers.advocatemcp.com/admin/*   admin-only
<customer-domain.com>/*             bot routing via Cloudflare for SaaS
```

### Navigation model

Marketing pages use the existing `.ln-nav` top nav. Logged-in pages (dashboard, settings, activate) use the `.db-side` sidebar layout already mocked up in `#page-dashboard` of `site/index.html`. The login page uses a centered card layout with no sidebar.

### Session and auth model

Details in Section 6. At a high level: the new `POST /api/auth/login` endpoint on `customers.advocatemcp.com` accepts JSON credentials and returns a session token (likely HttpOnly cookie with parent-domain scope, OR an opaque token in the response body that the frontend stores and forwards as a Bearer header). The browser on `advocatemcp.com` then includes credentials on every subsequent API call.

### CORS contract

`advocatemcp.com` is the only customer-facing origin. The worker's CORS policy explicitly allows:

```
Access-Control-Allow-Origin: https://advocatemcp.com
Access-Control-Allow-Credentials: true     (only if using cookie-based auth)
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, X-Activation-Token
Vary: Origin
```

`www.advocatemcp.com` should also be allowed if the marketing site is served from both. Every other origin gets no allow header → browser rejects.

### End-state description (for a stranger reading cold)

> AdvocateMCP's customer-facing product lives entirely on `advocatemcp.com`. A visitor lands on the marketing home, scrolls through pricing, clicks "Get Started," fills out a 5-step wizard, and pays via Stripe Checkout. After payment, they receive an email with a signed activation link. They click the link and land on `advocatemcp.com/activate?t=<token>`, enter their domain, and see DNS records to add at their registrar. After DNS propagates, they can log in at `advocatemcp.com/login` and view their dashboard at `advocatemcp.com/dashboard` — a 6-section analytics view showing AI queries, referral clicks, bot activity, recommendations, and settings. They never visit `customers.advocatemcp.com` directly; that hostname exists only as a backend (bot routing for their domain, JSON APIs the frontend calls, Stripe webhook receiver, and admin tools). All pages share the warm-dark Instrument Serif + General Sans brand identity with teal accent. The sidebar-based dashboard layout is consistent with `conduit.ai`'s information architecture.

---

## Section 6 — Cross-origin auth design

**This is the single most important technical decision in the rearchitecture.** Every subsequent choice hinges on it.

### The problem

Pages on `advocatemcp.com` need to call JSON APIs on `customers.advocatemcp.com` with an authenticated user context. Today's session cookie (`amcp_session`) is HttpOnly, Secure, SameSite=Lax, and scoped to the exact origin that sets it — `customers.advocatemcp.com`. A browser on `advocatemcp.com` cannot read or send this cookie.

Three viable options.

### Option 1 — Parent-domain cookie scope (`Domain=.advocatemcp.com`)

Change `sessionCookieHeader()` in `worker/src/auth.ts:99-108` to add `Domain=.advocatemcp.com`. The cookie becomes visible to both `advocatemcp.com` and `customers.advocatemcp.com`. Browsers send it on every request to either subdomain.

**Pros:**
- Minimal code change (one line in `auth.ts` plus SameSite adjustment).
- HttpOnly preserved — no XSS exposure to JavaScript.
- Works with existing session DB schema unchanged.
- Automatic — no manual token plumbing in the frontend.

**Cons:**
- Requires `SameSite=None; Secure` for cross-origin `fetch` calls (from `advocatemcp.com` to `customers.advocatemcp.com` is cross-site in the "registrable domain" sense for some browser definitions, though technically same-site per the modern same-site definition since both share `advocatemcp.com`). **Need to verify browser behavior here** — modern Chrome/Firefox/Safari treat `advocatemcp.com` and `customers.advocatemcp.com` as same-site and `SameSite=Lax` should suffice, but older definitions were stricter.
- CORS config must send `Access-Control-Allow-Credentials: true` and the browser `fetch` must use `credentials: 'include'`.
- Any script on `advocatemcp.com` getting XSS'd has the same cookie as a script on `customers.advocatemcp.com` — the blast radius is now parent-domain-wide.
- If a third subdomain is ever added (e.g. `admin.advocatemcp.com`), the cookie is visible there too, which may be undesirable.

### Option 2 — Token-based auth (opaque bearer token in Authorization header)

`POST /api/auth/login` accepts JSON credentials and returns `{token: "..."}` in the response body. The frontend stores the token (localStorage or a non-HttpOnly cookie set by JavaScript) and forwards it on subsequent API calls as `Authorization: Bearer <token>`. The worker verifies the token on each request by looking it up in the existing sessions table.

**Pros:**
- No cookie-scoping complexity. Each hostname is independent.
- No SameSite issues — it's all explicit.
- CORS doesn't need `credentials: true` — tokens ride in normal headers.
- Easy to reason about. Easy to revoke (delete the session row).
- Same pattern as most modern SaaS products.
- Admin API endpoints can be extended to accept the same token shape if useful.

**Cons:**
- Token is accessible to JavaScript (by design) → XSS on `advocatemcp.com` can exfiltrate it. Mitigation: Content-Security-Policy, tight eval/inline-script rules, no third-party script injection.
- Slightly more frontend code (store, include, refresh).
- Password reset and "remember me" flows need explicit design (same as today).

### Option 3 — OAuth-style redirect flow

`advocatemcp.com/login` submits to `customers.advocatemcp.com/auth/login`, the worker sets its own cookie on its own domain, then redirects back to `advocatemcp.com/dashboard?auth_token=<one-time>`. The frontend exchanges the one-time token for an API-usable credential.

**Pros:**
- Mirrors mature OAuth flows.
- Cookie stays on `customers.advocatemcp.com` where it always has been.

**Cons:**
- Significantly more complex than options 1 or 2.
- Redirect-round-trip UX for every login.
- One-time token exchange adds an endpoint and a state-management layer.
- Overkill for a single-product single-IDP setup.

### Recommendation — **Option 2 (token-based, Bearer in Authorization header)**

Reasoning:

1. **Simplest mental model.** Frontend stores a token; frontend sends a token. No browser-behavior-dependent cookie magic. No "does this work on Safari when iframed" questions.

2. **No CORS credentials complexity.** `Access-Control-Allow-Credentials: true` is the single most bug-prone CORS setting in existence — any reflection of `Origin` needs to be literal, `*` is banned, preflights have different rules. Option 2 avoids the entire category.

3. **Reuses existing session DB.** The `sessions` table in D1 already stores `token_hash` (SHA-256 of the raw token). The new `/api/auth/login` endpoint can mint a raw token the same way `createSession()` does today (`auth.ts:59`), store the hash, return the raw token to the frontend. The worker's `getSessionByToken()` already hashes-and-compares on each request. Zero schema changes.

4. **Forward-compatible.** If mobile apps, CLI tools, or third-party integrations are ever added, they can authenticate with the same `POST /api/auth/login` → Bearer token flow. Cookies don't work for those.

5. **XSS exposure is manageable with CSP.** `advocatemcp.com` is a static HTML site with a controlled script surface. Adding a strict CSP (`script-src 'self' unpkg.com cdn.jsdelivr.net api.fontshare.com fonts.googleapis.com`, no `unsafe-eval`, no `unsafe-inline` beyond hashed exceptions) makes XSS much harder to exploit, and the worst-case exfiltration of a single user's session token is a bounded incident.

6. **Option 1's SameSite question is a real unknown.** Chrome and Firefox both treat `advocatemcp.com` and `customers.advocatemcp.com` as same-site under the modern "schemeful same-site" rules, so `SameSite=Lax` should technically work. But I've seen subtle bugs in this area before and I don't want the rearchitecture to depend on something that might break in a browser update.

**Practical implementation notes for Option 2:**

- New endpoint `POST /api/auth/login` on the worker. Accepts `{email, password}` JSON. Validates via the existing `verifyPassword()` + `getUserByEmail()` flow. On success, generates a raw 64-char hex token via `generateSessionToken()`, hashes it, stores in `sessions` via `createSession()`, returns `{token, user: {id, email, full_name, role}}`. CORS: allow `advocatemcp.com` origin, no credentials needed.
- New endpoint `POST /api/auth/logout`. Accepts `Authorization: Bearer <token>`, deletes the matching session row, returns 200.
- Frontend stores the token in `localStorage` under a dedicated key (e.g. `amcp_auth_token`). On app load, reads the token and stores in a module-level variable. Every `fetch` call includes `Authorization: Bearer ${token}` in headers.
- Existing `/api/client/me`, `/api/client/metrics`, `/api/client/activity`, `/api/client/rotate-key` endpoints are extended to accept the Bearer header (today they read from the cookie). Add a helper `getSessionFromRequest(request, env)` that checks the Authorization header first, then falls back to the cookie for backward compatibility during transition.
- The existing form-based `POST /auth/login` (`portal.ts:122`) stays during coexistence — it's what the old `customers.advocatemcp.com/dashboard` still uses. It gets deleted in Phase E cleanup.

**Alternative to revisit if Option 2 turns out to be wrong**: fall back to Option 1 (parent-domain cookie scope) as a second-choice. It's a one-line change in `sessionCookieHeader()` and the browser-behavior concerns can be verified empirically before the main cutover.

---

## Section 7 — API contract inventory

Every JSON endpoint the worker currently exposes that the new `advocatemcp.com` frontend will call. Grouped by category. "New" marks endpoints that need to be newly created.

### Auth

| Method + path | New? | Auth | Request | Response | CORS today |
|---|---|---|---|---|---|
| `POST /api/auth/login` | **NEW** | none (validates credentials) | `{email, password}` | `{token, user: {id, email, full_name, role}}` | needs `advocatemcp.com` allow |
| `POST /api/auth/logout` | **NEW** | Bearer | `{}` | `{ok: true}` | needs `advocatemcp.com` allow |

### Client (session-gated)

| Method + path | New? | Auth | Request | Response | CORS today |
|---|---|---|---|---|---|
| `GET /api/client/me` | exists | cookie | — | `{id, email, full_name, role}` | **needs extension**: accept Bearer token, add `advocatemcp.com` CORS |
| `GET /api/client/metrics?slug=` | exists | cookie | — | `AnalyticsData` object (see `dashboard.ts:8-27`) | same |
| `GET /api/client/activity?slug=` | exists | cookie | — | `recent_queries[]` array | same |
| `POST /api/client/rotate-key?slug=` | exists | cookie | `{}` | `{ok: true, new_api_key}` | same |

### Onboarding + activation

| Method + path | New? | Auth | Request | Response | CORS today |
|---|---|---|---|---|---|
| `POST /api/onboard/public` | exists | none | `{slug, name, email, plan, referral_url, profile}` | `{ok, slug, status, plan, checkoutUrl, sessionId}` or error | already CORS'd for `advocatemcp.com` |
| `OPTIONS /api/onboard/public` | exists | none (preflight) | — | 204 + CORS headers | ✓ |
| `GET /api/onboard/session/:session_id` | exists | none (for `skipDns`) or admin | — | `{sessionId, slug, status, plan, paymentStatus}` | ✓ |
| `POST /api/activate` | exists | X-Activation-Token | `{domain, token}` | `{ok, slug, domain, cf_hostname_id, origin_url, origin_url_source, cname_record, txt_record, status, instructions, customer_message}` or error | **needs CORS extension** |

### Stripe

| Method + path | New? | Auth | Request | Response | CORS today |
|---|---|---|---|---|---|
| `POST /api/stripe/webhook` | exists | Stripe signature | Stripe event payload | `"OK"` text | N/A (server-to-server, no browser CORS) |

### Admin (unchanged, still X-Admin-Secret)

All admin endpoints stay on `customers.advocatemcp.com` and don't need CORS changes because they're never called from the browser — only from Cameron's terminal with `curl -H "X-Admin-Secret: ..."`.

- `POST /admin/create-client`
- `POST /admin/domains/activate`
- `POST /admin/activation-token` (temporary)
- `GET /admin/domains/:slug/status`
- `POST /api/onboard/basic` (admin-protected, currently called only by the dead worker wizard — gets deleted in Phase E)
- `POST /api/onboard` legacy
- `GET /api/onboard/list`
- `POST /api/onboard/verify-all`
- `GET /api/onboard/:domain/status`
- `POST /api/onboard/:domain/verify`
- `POST /api/onboard/:domain/disable`

### Endpoints that need building or changing

Summary of the deltas:

1. **Build**: `POST /api/auth/login` + `POST /api/auth/logout` — new endpoints in `worker/src/routes/portal.ts` or a new `worker/src/routes/authApi.ts`.
2. **Extend**: `/api/client/me`, `/api/client/metrics`, `/api/client/activity`, `/api/client/rotate-key` — add Bearer token auth support (in addition to existing cookie support) and `advocatemcp.com` CORS.
3. **Extend**: `/api/activate` — add `advocatemcp.com` CORS.
4. **Extend**: CORS helper in `stripe.ts:31-46` already allows `advocatemcp.com` for `/api/onboard/public` — the same helper should be reused for the new endpoints.

Total new endpoint surface: 2 endpoints. Extension work: 5 existing endpoints gain Bearer auth and CORS. Everything else is untouched.

---

## Section 8 — Phased execution plan

Six phases, A through F. Phase A is this planning document (already complete). Execution starts with Phase B.

### Phase A — Planning (this document)

**Status**: complete. Scope: read files, write plan. No code changes. No production impact.

### Phase B — Stripe Checkout unblock

**Priority**: critical-path. Every paying customer currently fails here.

**Scope**: diagnose and fix the "Failed to create Stripe Checkout Session" error observed on `advocatemcp.com/onboarding.html`. Hypothesis from the earlier audit: Stripe mode drift between `STRIPE_SECRET_KEY` and `STRIPE_PRICE_ID_BASE`/`PRO`. Diagnostic probe already exists at `stripe.ts:398-407`.

**Files touched**:
- None in code if the root cause is a secret drift — the fix is a `wrangler secret put` operation only.
- `stripe.ts:398-407` can be removed after verification (cleanup).

**Execution steps**:
1. `cd worker && npx wrangler tail` in one terminal.
2. Reproduce the Stripe failure by clicking "Publish" on `advocatemcp.com/onboarding.html`.
3. Watch for the `stripe_key_probe` log line. Confirm secret_prefix, base_price_prefix, pro_price_prefix, webhook_secret_prefix values.
4. If prefixes mismatch (`sk_test_` + `price_...` from live mode, or vice versa): reconcile by setting all four to the same mode. Verify with a second test click.
5. If prefixes match but Stripe still errors: inspect the detail field in the Worker's 502 response. Likely next suspect: archived price ID or deleted Stripe product.
6. After fix, verify by completing a real test-mode purchase end-to-end — through Stripe Checkout, webhook, and `/onboarding/complete.html`.

**Exit criteria**:
- A test-mode purchase completes end-to-end without error.
- Webhook transitions a `skipDns` tenant to `active`.
- `/onboarding/complete.html` polls successfully and shows the success state.

**Tests to add**: none (infrastructure issue, not code).

**Rollback**: if a secret rotation goes wrong, reset the secret to its previous value via `wrangler secret put`.

**Estimate**: 30 minutes to 2 hours depending on whether the root cause is obvious.

### Phase C — Cross-origin API and auth foundation

**Status: SHIPPED 2026-04-11.** Commits `63f1e30` (flaky-test sidetrack), `d016946` (schema + env field), `5dc6289` (access token library), `06339a4` (shared CORS helper), `48c5978` (auth endpoint handlers + refresh cookie helpers), `92ca150` (route registration + Bearer middleware + backwards-compat preserved), plus Commit 6 (this doc update). Final implementation ratified the hybrid access-token + refresh-cookie design described in Section 6 and added `POST /api/auth/refresh` as a third endpoint (beyond the two listed in the original Section 7 inventory) so access tokens can be rotated without forcing the user to re-login every 15 minutes. All five manual E2E verifications passed: admin form login preserved, admin dashboard rendered with the synthesized User from AuthContext, cookie-authenticated `/api/client/me` returned 200, OPTIONS preflight on `/api/auth/login` returned 204 with the expected CORS headers, and `POST /api/auth/login` with invalid credentials returned 401 with the customer-friendly error shape. `ACCESS_TOKEN_SIGNING_KEY` secret deployed during the Commit 5 verification phase and is live on the worker.

**For the full execution log**, including the architectural decisions surfaced during implementation (loginPage / requireSession conflict resolved as Option C, `activate.ts` CORS wrapping switched from silent dispatch-site wrap to self-contained inner/outer pattern, and the mid-session admin password reset detour), see `docs/session-2026-04-11-phase-c-cross-origin-auth-foundation.md`.

**Scope** (as originally planned): implement the new `POST /api/auth/login` + `POST /api/auth/logout` endpoints. Extend the five existing `/api/client/*` + `/api/activate` endpoints to accept Bearer tokens and allow the `advocatemcp.com` CORS origin. Build a shared `getSessionFromRequest()` helper that checks Authorization header first, then cookie.

**Files touched**:
- `worker/src/routes/portal.ts` — add new route lines for `/api/auth/login`, `/api/auth/logout`. Modify existing `apiMe`, `apiMetrics`, `apiActivity`, `apiRotateKey` to use the new helper.
- `worker/src/routes/authApi.ts` — new file containing `handleAuthLogin`, `handleAuthLogout`, and the `getSessionFromRequest` helper. Reuses existing `verifyPassword`, `getUserByEmail`, `createSession`, `deleteSession`, `hashToken` from `auth.ts` and `portalDb.ts`.
- `worker/src/routes/activate.ts` — extend `handleActivate` to emit the right CORS headers when the request origin is `advocatemcp.com` or `www.advocatemcp.com`.
- A shared CORS helper that either lives in a new `worker/src/lib/cors.ts` or reuses the existing helper in `stripe.ts`. **Recommendation**: promote the `stripe.ts` helper into a shared library during this phase since it's now used by four endpoints.

**Tests to add**:
- `worker/src/routes/authApi.test.ts` — unit tests for the login/logout handlers (happy path, wrong password, rate limit, expired token, malformed body).
- Extend existing tests as applicable.

**Exit criteria**:
- A `curl` call to `POST /api/auth/login` with valid credentials returns a token.
- A subsequent `curl` call to `GET /api/client/me` with `Authorization: Bearer <token>` returns the user JSON.
- CORS preflight `OPTIONS` requests from `https://advocatemcp.com` return the expected `Access-Control-Allow-*` headers.
- Existing cookie-based `/dashboard` still works (backward compatibility preserved).

**Rollback**: the new endpoints are additive. If anything breaks, delete the new route lines from `portal.ts` and the new file. Existing flows are untouched.

**Estimate**: 3–5 hours including test writing.

### Phase D — Build the dashboard frontend on advocatemcp.com

**Scope**: create new static HTML pages for login and dashboard on `advocatemcp.com`, styled with the brand tokens from Section 2, laid out per the sidebar mockup in `site/index.html#page-dashboard`. Extract the dashboard markup from that mockup, wire it to the live `/api/client/metrics` + `/api/client/activity` endpoints via Bearer token auth.

**Files touched** (in the `site/` folder, which is a separate deploy pipeline):
- `site/login.html` — new. Centered card layout with email + password form. Submits via `fetch` to `POST /api/auth/login`. On success, stores the token in `localStorage` and redirects to `/dashboard`.
- `site/dashboard.html` — new. Extracted from `site/index.html#page-dashboard`. Wired to live API via Bearer token. Six sections matching the current `dashboard.ts` feature set: Overview, AI Requests, Referral Clicks, Bot Activity, Recommendations, Settings.
- `site/activate.html` — new. Extracted from `worker/src/routes/activatePage.ts` and re-styled in brand tokens. Reads `?t=<token>` from URL, calls `POST /api/activate` via `fetch`.
- Shared JavaScript module (or inline script) implementing: token storage, `fetch` wrapper that attaches `Authorization: Bearer`, session expiration handling (redirect to `/login` on 401).

**Tests to add**: this is static HTML with no test infrastructure. Manual E2E verification only. Future: add a minimal Playwright or Vitest-browser setup if the page count grows.

**Exit criteria**:
- A customer can visit `advocatemcp.com/login`, enter credentials, get redirected to `advocatemcp.com/dashboard`, and see live data.
- The dashboard matches the brand design tokens byte-for-byte.
- All six dashboard sections render.
- Domain activation via `advocatemcp.com/activate?t=<token>` works end-to-end.

**Rollback**: the new pages live at new URLs on `advocatemcp.com`. They don't touch the existing worker pages at `customers.advocatemcp.com/dashboard|login|activate`, which continue to work. If the new pages are broken, rolling back is just reverting the deploy of the `site/` folder to the previous state.

**Estimate**: 8–16 hours. Biggest phase. Includes building the dashboard JavaScript that consumes the API responses and renders Chart.js charts.

### Phase E — Deprecation and cleanup of worker HTML

**Scope**: once Phase D is verified working in production, delete the worker's customer-facing HTML handlers. Redirect the old URLs to the new ones.

**Files touched**:
- `worker/src/routes/onboardPage.ts` — delete file entirely.
- `worker/src/routes/dashboard.ts` — delete the `buildDashboard` function and all of its HTML/CSS. Keep the `AnalyticsData` interface if it's imported elsewhere, or move it to a types file.
- `worker/src/routes/portal.ts` — replace the route handlers for `/login`, `/dashboard`, `/onboard`, `/activate` with 301 redirects to `advocatemcp.com/login`, `advocatemcp.com/dashboard`, `advocatemcp.com/onboarding`, `advocatemcp.com/activate` (preserving query string). Delete the `loginPage`, `loginHtml`, `dashboard`, `statusPage`, `statusHtml` functions if they're no longer referenced.
- `worker/src/routes/activatePage.ts` — delete file entirely.
- `worker/src/routes/sharedLayout.ts` — delete file entirely once all consumers are gone. If `/demo` pages still use it, defer until `/demo` is also migrated or explicitly kept.
- `worker/src/index.ts` — the `RESERVED` set at line 409 may be pruned (e.g. remove `"activate"` if the `/activate` worker route is removed), but leaving the set unchanged is fine for defense-in-depth.

**Tests to add**: none. Removal-only phase. Existing tests should continue to pass.

**Exit criteria**:
- Every customer-facing HTML handler in the worker is deleted.
- Redirects from the old URLs to the new URLs work and preserve query strings.
- `customers.advocatemcp.com/dashboard` → `advocatemcp.com/dashboard` (302 or 301).
- Worker size reduced by ~2500–2800 lines.
- No HTML pages served by the worker except possibly `/demo` and `/status` (decision deferred).

**Rollback**: if something breaks, the entire worker HTML stack is still in git history at commit `c6042ba` (Phase 3 spine). Revert the specific deletes.

**Estimate**: 2–4 hours.

### Phase F — Stripe webhook → activation token → email wiring

**Scope**: close the loop so a paying customer automatically receives an activation link via email. Today, Cameron has to manually run `POST /admin/activation-token` and email the link himself.

**Files touched**:
- `worker/src/routes/stripe.ts` — in `handleStripeWebhook`, after transitioning the tenant to active, mint an activation token via `signActivationToken({slug: tenant.slug}, env.ACTIVATION_SIGNING_KEY)` and send an email via Resend containing the token-URL.
- New file `worker/src/lib/email.ts` or similar — Resend integration. Requires new env var `RESEND_API_KEY`.
- `worker/src/types.ts` — add `RESEND_API_KEY?: string`.
- Email templates (likely embedded as template literals in TypeScript for the spine, or eventually moved to markdown files).

**Tests to add**: unit test for the email-sending helper with a mock Resend client.

**Exit criteria**:
- Completing a test-mode purchase triggers an email containing an activation link.
- Clicking the link lands on `advocatemcp.com/activate?t=<token>` and the token validates successfully.
- The temporary `POST /admin/activation-token` endpoint is marked for removal (or removed outright).

**Rollback**: email sending is additive. If Resend fails or the template has a bug, roll back by deleting the send call from the webhook handler.

**Estimate**: 3–5 hours including template design and test-mode verification.

### Suggested phase sequencing

**B → C → D → E → F** is the natural order, but B can happen any time (it's a diagnostic fix) and **B is urgent**. Phases C and D can overlap somewhat — C is backend-only, D is frontend-only, and they share the API contract defined in Section 7. A working-in-parallel model: draft the new endpoints in C while simultaneously building the static pages in D against stub API responses, then wire them together when both sides are ready.

---

## Section 9 — Transition and coexistence strategy

During phases C and D, both old and new customer-facing surfaces will be live simultaneously. This coexistence is a feature, not a bug — it lets new work ship behind feature flags without breaking existing production flows.

### Coexistence rules

1. **New pages on `advocatemcp.com` go live first, old pages on `customers.advocatemcp.com` stay live until verified.** No deletion before verification.

2. **Old cookie-based auth keeps working throughout Phase C.** The new `/api/auth/login` Bearer endpoint is additive. Existing dashboard at `customers.advocatemcp.com/dashboard` still uses the cookie, still works. The helper `getSessionFromRequest()` checks both.

3. **No cross-wiring of old pages to new endpoints.** Don't modify the old dashboard to call the new API — that's extra work for a page that's being deleted. Let the old dashboard die with its old plumbing intact.

4. **New pages test against production API from day one.** No staging backend. The new `advocatemcp.com/dashboard` calls the live `customers.advocatemcp.com/api/client/metrics` immediately after Phase C ships. Bugs surface in the real environment where they'll actually be caught.

5. **Parallel test flow**: Cameron logs into the new `advocatemcp.com/login`, verifies dashboard works, while simultaneously keeping the old `customers.advocatemcp.com/login` tab open as a fallback. If the new flow breaks, the old flow is still a working escape hatch.

### Redirect strategy

Once Phase D is verified in production:

- `customers.advocatemcp.com/login` → 301 `https://advocatemcp.com/login`
- `customers.advocatemcp.com/dashboard` → 301 `https://advocatemcp.com/dashboard` (preserve `?slug=` query param)
- `customers.advocatemcp.com/onboard` → 301 `https://advocatemcp.com/onboarding`
- `customers.advocatemcp.com/activate?t=<token>` → 301 `https://advocatemcp.com/activate?t=<token>` (preserve query string)

Redirects are permanent (`301`) because the new URLs are the canonical customer-facing locations. Any bookmarks or email links to the old URLs transparently upgrade.

### Database and KV coexistence

All session data and business data in D1 and KV is hostname-agnostic. The session `token_hash` rows don't care which hostname created them. A session minted by the old cookie flow validates the same way as a session minted by the new Bearer flow — they share the same `sessions` table. This is the critical property that makes Phase C additive: no data migration needed.

### Testing in parallel

During Phase D, the new static HTML pages can be served from a subdomain like `staging.advocatemcp.com` or a preview deploy in the marketing-site pipeline. Only after E2E verification does the traffic cut over to the canonical URLs. Specifics depend on which deploy pipeline `advocatemcp.com` uses (Cloudflare Pages, Netlify, Vercel) — see the unknowns in Section 10.

### What NOT to do during transition

- Don't delete the worker's `dashboard.ts` before the new dashboard is verified working.
- Don't change the session cookie's `Domain` attribute or `SameSite` policy during Phase C — the new flow uses Bearer tokens, it doesn't need cookie changes. Save that for Phase F or a future session.
- Don't mix the design token sets. The new pages use only the brand tokens from Section 2. The old pages keep their old tokens until they're deleted.

---

## Section 10 — Risks, open questions, dependencies

### Risks

**R1 — The marketing site deploy pipeline is opaque to this repo.** We don't know whether `site/` is deployed via Cloudflare Pages (watching a specific branch of a separate repo), Netlify, Vercel, or manual upload. Phase D depends on being able to ship new HTML files through that pipeline. **Mitigation**: Cameron confirms the pipeline before Phase D starts, and confirms whether new files in `site/` can be added through the existing workflow or need separate upload.

**R2 — CORS preflight bugs.** Phase C's cross-origin API work is the single most bug-prone part of any rearchitecture. Browsers have subtle differences in CORS behavior, especially around `OPTIONS` preflights, credentialed requests, and origin matching. **Mitigation**: extensive manual testing from a real browser on `advocatemcp.com` (not just `curl`) before Phase D starts. Check Chrome, Firefox, Safari at minimum.

**R3 — Token-based auth has different XSS characteristics than cookie auth.** If `advocatemcp.com` ever serves third-party scripts, injected content, or unsanitized user input, an attacker could exfiltrate tokens from `localStorage`. **Mitigation**: add a strict Content-Security-Policy header on `advocatemcp.com` during Phase D. No `unsafe-inline`, no third-party scripts beyond the known Fontshare/Google Fonts/Lucide/Chart.js origins, no script injection points.

**R4 — Stripe webhook idempotency gap.** Documented in the earlier audit. Not a blocker for the rearchitecture, but if Phase F's email sends fire on a duplicate webhook delivery, the customer receives duplicate emails. **Mitigation**: add processed-event tracking in Phase F (SHA-256 hash of the event ID stored in KV with TTL).

**R5 — Dashboard data shape mismatch between old and new.** The new `advocatemcp.com/dashboard` is building against the `AnalyticsData` interface from `worker/src/routes/dashboard.ts:8-27`. That interface is defined server-side and returned from `/api/client/metrics`. If the API shape changes during transition, the new frontend breaks silently. **Mitigation**: freeze the API shape during Phase C. No refactoring of the `AnalyticsData` interface until Phase D is verified.

**R6 — The session table has no cross-device token awareness.** Every login mints a new token. Logging in on a second device doesn't invalidate the first. This is true today and remains true after the rearchitecture. Not urgent, but worth a "log out all devices" feature in a future session.

**R7 — The design tokens drift between `site/` and any new stylesheet.** If the rearchitecture duplicates the `:root {}` block into multiple files (login, dashboard, activate), any future update to a color or font has to be made in multiple places. **Mitigation**: extract the tokens into a single shared stylesheet at `site/brand-tokens.css` during Phase D, imported by every page via `<link>`.

### Open questions (require Cameron input)

**Q1**: What is the actual deploy pipeline for `advocatemcp.com` today? (Cloudflare Pages? Netlify? Vercel? Manual FTP? A separate git repo?)

**Q2**: Does the existing `site/index.html` have an ongoing editing workflow (branch + deploy), or is it edited directly on production?

**Q3**: What's the real support contact address? The Phase 3 planning doc flagged `mailto:max@advocate-mcp.com` as a placeholder. This applies to the new login/dashboard/activate pages as well.

**Q4**: Should `/demo` and `/status` stay on the worker as public surfaces, or migrate to `advocatemcp.com` with the rest?

**Q5**: Light-mode support. The existing tokens have a light palette, but none of the worker's pages use it today. Should the rearchitecture enable a user-toggleable light mode on the dashboard from day one, or defer to a future session?

**Q6**: Mobile experience. The existing `site/` has mobile breakpoints and a hamburger menu. The worker dashboard has its own mobile handling. What's the mobile-first requirement for the new dashboard — full feature parity, or a reduced "read-only summary" mode for phones?

**Q7**: Password reset. Should Phase C include a minimal password-reset flow (`POST /api/auth/request-reset` + email + `POST /api/auth/reset`), or is that deferred to a later session?

**Q8**: What does the customer see between paying and receiving their activation email? Today the `/onboarding/complete.html` page polls and shows a success message. In the new world, does it show the same polling behavior until the email is sent, or does it redirect to `/login` with a "check your email" message, or something else?

### External dependencies

- **Stripe test-mode account** with valid `sk_test_` secret key, `price_test_` price IDs, and a `whsec_...` webhook secret for the Phase B verification.
- **Resend API key** for Phase F email sending. Not yet procured.
- **Cloudflare DNS control** over `advocatemcp.com` and `customers.advocatemcp.com` for any routing changes during Phase E.
- **The external deploy pipeline** for `advocatemcp.com` (see R1, Q1).

---

## Section 11 — Immediate next session

### What is the very first session after this planning doc?

**Phase B — Stripe Checkout unblock.** It's critical-path, unblocks the funnel for real revenue, and doesn't depend on any other phase. It's also the smallest phase by a wide margin.

### Scope of the next session

1. **Read**: the `stripe_key_probe` diagnostic at `worker/src/routes/stripe.ts:398-407`.
2. **Run**: `cd worker && npx wrangler tail` in one terminal.
3. **Reproduce**: open `advocatemcp.com/onboarding.html` in a browser, fill out the 5-step wizard, click "Publish." Observe the log output.
4. **Diagnose**: identify which of (a) mode mismatch, (b) archived price ID, (c) something else is causing the Stripe API to reject the Checkout Session creation.
5. **Fix**: reconcile secrets via `wrangler secret put` (no code changes expected). If code changes are needed, propose them before making changes per the existing propose-then-approve discipline.
6. **Verify**: complete a test-mode purchase end-to-end — wizard → Stripe Checkout → webhook → `/onboarding/complete.html` shows success.
7. **Cleanup**: if the `stripe_key_probe` diagnostic has served its purpose, remove it as a follow-up commit.

### What Claude Code reads first in the next session

- `docs/rearchitecture-plan-2026-04-10.md` (this document, if not already in context).
- `worker/src/routes/stripe.ts:125-328` (`handleBasicOnboard`) and `stripe.ts:338-565` (`handlePublicOnboard`) — already read during this audit, but should be re-read in fresh context.
- Live `wrangler tail` output. The diagnostic probe will reveal the root cause directly.

### What the first commit of the next session will be

**If the root cause is a secret drift**, the first commit is documentation-only — updating `docs/attribution.md` with a "Production state observation" entry similar to the API_KEY drift entry from Phase 1.5. The actual fix happens via `wrangler secret put` and doesn't produce a commit.

**If the root cause requires code changes**, the first commit is the fix itself with a message like `fix(worker): <root cause description>` and an explanation in the body.

**Likely message**: `fix(worker): reconcile Stripe test-mode secrets` or `docs(attribution): document Stripe checkout session recovery`.

### Turning the plan into actionable next steps

1. **Immediately after this document commits**: Cameron opens `wrangler tail` and reproduces the Stripe failure. 15 minutes.
2. **Diagnose + fix**: 30 minutes to 2 hours depending on what `wrangler tail` shows.
3. **End-to-end verification of a test-mode purchase**: 30 minutes.
4. **Move to Phase C** after Phase B is verified and cleanup is committed.

Total for Phase B: most of an evening, possibly less. Phase C starts when Phase B lands.

---

## Appendix: quick reference

### Commit lineage this was produced against

- `894529c` — Phase 2 origin auto-discovery
- `1f4c94e` — Phase 2 regression tests for unresolvable domains
- `d5b1ba7` — Phase 2 semantic fix
- `61dbf3b` — Phase 2 docs
- `a2d0f8a` — Phase 1.5 proxy cleanup
- `d983251` — Phase 1.5 docs
- `c6042ba` — Phase 3 spine
- `a917497` — Phase 3 docs (initial)
- `f8150d4` — CLAUDE.md in-progress pointer at this document (just shipped)

### Worker version in production (as of 2026-04-10)

`2e6760be-ed7e-4f06-8706-e154b0ec8519` — Phase 3 spine live.

### Files NOT read during this audit

Flagged for transparency. If something in the planning seems incomplete, these are the gaps:

- `worker/src/routes/onboard.ts` beyond the export surface and key handlers. The full body of `handleOnboard`, `handleVerifyDomain`, `handleOnboardStatus`, `handleOnboardList`, `handleVerifyAll`, `handleDisableTenant` — not read in full. These are admin-path legacy endpoints; their internals are unlikely to matter for the rearchitecture but they may have surprises.
- `worker/src/routes/onboardPage.ts` lines 730–1034 (the render logic for steps 3–4 of the dead wizard). Skimmed only.
- `site/index.html` lines 788–2007 (everything after the CSS — the actual body markup, mobile menu, scripts, dashboard mockup HTML). Design tokens and mockup CSS are fully extracted; the actual HTML of sections (ticker, features, outcomes, case studies, pricing, footer) is known from the earlier audit but not quoted here.
- `site/onboarding.html` body markup beyond the form-submission section (steps 1–5 UI is present and visible in the code but not transcribed here).
- `site/onboarding/complete.html` beyond the design tokens at the top. The polling logic exists but is not described in detail.
- `site/terms.html`, `site/privacy.html`, `site/dpa.html` — not audited for content. Legal status unknown.
- `worker/src/routes/demo.ts` — not read during this audit. `/demo` surface is out of scope for the rearchitecture's customer-facing work.
- `worker/src/routes/portal.ts` lines beyond the dispatcher and key handlers (302–654). Functions like `statusPage`, `statusHtml`, `adminCreateClient` body, `buildDashboard` call path are either read or skimmed.

None of these gaps block the planning work above. They are enumerated so future sessions know exactly where to look if a specific detail is missing from this document.

---

**End of document. Saved to working tree, not committed. Cameron to review and tweak before committing in the morning.**

---

## Section 12 — Phase D: Dashboard Consolidation

*Drafted 2026-04-11. Approved by Cameron before commit.*

### 12.0 Critical findings

Four gaps between the Phase C API surface and what a real dashboard needs. Each is flagged with a resolution decision.

**CF-1: Access token does not survive page navigation.**
Phase C places access tokens in JS memory only (not localStorage). Any navigation event discards the token. Resolution: "refresh on every page load" pattern — `POST /api/auth/refresh` fires immediately on `dashboard.html` load before rendering any data. The persistent `amcp_refresh` cookie (HttpOnly, Secure, SameSite=Strict, Path=/api/auth/refresh, Max-Age=2592000) is included automatically because `advocatemcp.com` and `customers.advocatemcp.com` share the eTLD+1 `advocatemcp.com`, making same-site fetch calls with `credentials: 'include'` send the cookie. Approved: build this pattern into `site/js/dashboard-auth.js`.

**CF-2: No endpoint returns the current api_key.**
Dashboard B's Settings section shows customers their current api_key (masked, with show/copy/rotate). None of the Phase C endpoints (`GET /api/client/me`, `GET /api/client/metrics`) return `api_key`. `POST /api/client/rotate-key` returns only the new key after rotation. Resolution: Settings section ships as "API key configured" with rotate-only functionality. Adding `api_key` to `GET /api/client/me` requires a worker change outside Phase D scope. Flagged as open question Q2.

**CF-3: No domain status endpoint.**
Dashboard A's Domains section assumes domain hostname, activation status, and CNAME/TXT records are available. None of the Phase C endpoints return this data. `AnalyticsData` is pure analytics. Resolution: Domains section ships as a static stub in Commit 9. A `GET /api/client/domains` worker endpoint is a Phase E or later concern. Flagged as open question Q3.

**CF-4: "Add Domain" modal is incompatible with activation API.**
Dashboard A contains a modal collecting `{domain, slug}` that calls `POST /api/activate`. But `handleActivate` requires a signed activation token minted by the Stripe webhook — the modal's direct call cannot satisfy this contract. Resolution: The modal is removed from the consolidated dashboard. Domain activation goes through `site/activate.html` (Commit 8), reached via the Domains stub or the onboarding email.

**CF-5: `GET /api/client/metrics` returns two JSON shapes.**
When Railway is reachable the response is the full `AnalyticsData` object. When Railway is unreachable the response is `{ message: "No data available yet", slug: biz.slug }`. Dashboard JS must discriminate before rendering. Resolution: guard `typeof data.total_queries === 'number'` before rendering; render an empty-state card otherwise.

---

### 12.1 Current state of both dashboards

**Dashboard A** — `site/index.html #page-dashboard`
- Domain: `advocatemcp.com` — the right domain for the customer-facing product
- Visual design: canonical brand tokens (`--bg: #171614`, `--accent: #4f98a3`, `--font-serif: 'Instrument Serif'`, etc.) — the design we want to ship
- Data: entirely hardcoded — not wired to any API
- Auth: none — the section is visible to anyone who clicks "Dashboard" in the marketing page nav
- Sections: 4 (Overview stub, AI Requests stub, Referral Clicks stub, Domains stub with broken "Add Domain" modal)
- Status: visual prototype only, not a real product page

**Dashboard B** — `worker/src/routes/dashboard.ts` served at `customers.advocatemcp.com/dashboard`
- Domain: `customers.advocatemcp.com` — the wrong domain; customers land here only after the worker's portal login flow
- Visual design: cool-gray system-font (`--bg:#f9fafb; --card:#fff; --text:#111827`) — completely off-brand
- Data: live — powered by `fetchAnalytics` → Railway → `AnalyticsData`
- Auth: worker session cookie (`amcp_session`) — valid but portal-only, not Phase C Bearer
- Sections: 6 (Overview with 30-day chart + KPIs, AI Requests with trend + intent, Referral Clicks, Bot Activity with 7×24 heatmap, Recommendations, Settings with API key show/hide/copy/rotate)
- Status: fully functional, in production, will remain live through all of Phase D

---

### 12.2 Target state

A single dashboard at `advocatemcp.com/dashboard.html` that:
- Shows the canonical brand design (Dashboard A's CSS tokens, sidebar, topbar)
- Contains all 6 sections with live data (Dashboard B's logic, ported)
- Authenticates via Phase C Bearer + refresh cookie (no worker session cookie dependency)
- Fetches data from `https://customers.advocatemcp.com/api/client/metrics` using `credentials: 'include'`
- Handles token expiry silently by calling `POST /api/auth/refresh` before each page load
- Ships alongside (not replacing) Dashboard B — the worker version stays live during Phase D and Phase E

A companion login page at `advocatemcp.com/login.html` that:
- Accepts email + password
- Calls `POST /api/auth/login` at `customers.advocatemcp.com`
- Stores the returned `access_token` in `window.AMCP.token` (JS memory)
- On success, redirects to `dashboard.html`
- Handles all error codes: `invalid_credentials`, `rate_limited`, `platform_error`

A companion activation page at `advocatemcp.com/activate.html` that:
- Accepts a signed activation token from the URL query string (`?t=...`)
- Calls `POST /api/activate` with the token
- Shows success/error state
- On success, redirects to `login.html`

---

### 12.3 Architectural decision

**Dashboard A's visual shell is canonical. Dashboard B's data-display logic ports into it.**

Dashboard B's CSS is discarded entirely — all `--bg:#f9fafb` cool-gray tokens are replaced by Dashboard A's brand tokens. Dashboard B's six sections (HTML structure, JS rendering functions, event handlers) are extracted from the server-rendered TypeScript template and rewritten as client-side JS in plain `.js` files. Dashboard A's sidebar, topbar, and nav structure are extended from 4 to 6 section items.

Shared auth module: `window.AMCP` namespace.
```
window.AMCP = {
  token: null,           // access_token string, set after login or refresh
  API_BASE: 'https://customers.advocatemcp.com',
  login(email, password) → Promise<void>,
  logout() → Promise<void>,
  refresh() → Promise<boolean>,   // true = got new token, false = no cookie / expired
  authedFetch(path, opts) → Promise<Response>  // injects Authorization header
}
```

All fetch calls use `credentials: 'include'` so the `amcp_refresh` cookie travels cross-origin within the same eTLD+1.

No build tooling. All JS is plain `.js` loaded via `<script src="...">` tags. No TypeScript compilation, no bundler, no package.json in `site/`.

---

### 12.4 Phased execution plan

Ten commits, each proposed and approved individually before execution.

**Commit 1 — Auth layer**
Files: `site/login.html`, `site/js/dashboard-auth.js`
Work: Login form with brand tokens. `window.AMCP` module with login, logout, refresh, authedFetch. Error rendering for all four error codes. Redirect to `dashboard.html` on success. No dashboard HTML yet — just the auth infrastructure.
Estimate: 1–2h

**Commit 2 — Dashboard shell**
Files: `site/dashboard.html`
Work: Brand CSS (full token set from `site/index.html`). Sidebar with 6 nav items (Overview, AI Requests, Referral Clicks, Bot Activity, Recommendations, Settings). Topbar with business name + logout button. Main content area with skeleton `<section>` placeholders for each of the 6 sections. Auth gate: on load, call `AMCP.refresh()`; if returns false, redirect to `login.html`. No data wiring yet — all sections show "Loading…" placeholders.
Estimate: 2–3h

**Commit 3 — Overview section**
Files: `site/dashboard.html` (section), `site/js/dashboard-overview.js`
Work: Call `GET /api/client/metrics` via `AMCP.authedFetch`. Discriminate on `typeof data.total_queries === 'number'`. Render: insight text card, 4 KPI cards (total queries, referral clicks, top crawler, top intent), 30-day query trend bar chart (vanilla canvas or inline SVG), bot share horizontal bar chart.
Estimate: 2–3h

**Commit 4 — AI Requests + Referral Clicks sections**
Files: `site/js/dashboard-requests.js`, `site/js/dashboard-clicks.js`
Work: AI Requests: 30-day trend chart, top queries list, intent breakdown bars. Referral Clicks: total clicks KPI, clicks last 30 days KPI, bot source bars, explainer card.
Estimate: 2–3h

**Commit 5 — Bot Activity + Recommendations sections**
Files: `site/js/dashboard-bots.js`, `site/js/dashboard-recs.js`
Work: Bot Activity: crawler table with query counts, intent distribution bars, 7×24 activity heatmap (inline SVG grid). Recommendations: static recommendation cards based on intent data patterns, optimization checklist.
Estimate: 2–3h

**Commit 6 — Settings section**
Files: `site/js/dashboard-settings.js`
Work: Business profile display (name, slug, plan from `GET /api/client/me`). API key section: "API key configured — use Rotate to generate a new key" + Rotate button calling `POST /api/client/rotate-key`. Copy-to-clipboard on new key after rotation. (Full show/copy of current key deferred to Q2 resolution.)
Estimate: 1–2h

**Commit 7 — Login + auth E2E verification**
Files: no new files; fixes from manual testing
Work: Walk the full auth flow: login → dashboard loads → refresh cycle → logout → redirect. Fix any issues found. Verify 401 handling (refresh fails → redirect to login). Verify rate-limit message display.
Estimate: 1–2h

**Commit 8 — Activation page**
Files: `site/activate.html`, `site/js/dashboard-activate.js`
Work: Parse `?t=` from URL. Call `POST /api/activate` with token. Success state: "Your domain is active — sign in to see your dashboard" + link to `login.html`. Error states: expired token, already activated, invalid token.
Estimate: 2–3h

**Commit 9 — Domains stub + docs update**
Files: `site/dashboard.html` (Domains nav item + section), `docs/rearchitecture-plan-2026-04-10.md` (this file — update 12.0 CF-3 status)
Work: Add Domains as 7th nav item. Section content: "Domain routing is configured — contact support to update your domain" static card. No API calls. Note Q3 status.
Estimate: 1–2h

**Commit 10 — Full E2E verification matrix**
Files: no new files; fixes from matrix run
Work: Run full verification matrix from Section 12.6. Fix regressions. Tag the commit as Phase D complete.
Estimate: 1–2h

---

### 12.5 Integration contract

The frontend will call exactly these endpoints. No other worker or Railway endpoints are called directly from `site/`.

| Endpoint | Method | Auth | Used in |
|---|---|---|---|
| `/api/auth/login` | POST | none | `login.html` |
| `/api/auth/logout` | POST | Bearer | logout button |
| `/api/auth/refresh` | POST | refresh cookie | every `dashboard.html` load |
| `/api/client/me` | GET | Bearer | Settings section (name, role) |
| `/api/client/metrics` | GET | Bearer | all data sections |
| `/api/client/rotate-key` | POST | Bearer | Settings section |
| `/api/activate` | POST | signed token in body | `activate.html` |

All calls go to `https://customers.advocatemcp.com` (stored in `window.AMCP.API_BASE`).
All calls use `credentials: 'include'` (for refresh cookie transport).
All authenticated calls include `Authorization: Bearer ${window.AMCP.token}` header.

**Request/response shapes (from Phase C contracts):**

Login request: `{ email: string, password: string }`
Login response (200): `{ access_token, expires_in: 900, user: { id, email, full_name, role, tenant_id } }`
Login response (401): `{ ok: false, error_code: "invalid_credentials" }`
Login response (429): `{ ok: false, error_code: "rate_limited" }`

Refresh response (200): `{ access_token, expires_in: 900 }` + rotated cookie
Refresh response (401): `{ ok: false, error_code: "no_refresh_token" | "refresh_token_expired" }`

Metrics response (200, Railway up): full `AnalyticsData` object (see dashboard.ts interface)
Metrics response (200, Railway down): `{ message: string, slug: string }` — discriminate with `typeof data.total_queries === 'number'`

---

### 12.6 Verification plan

**Per-commit smoke test (run after every commit before pushing):**
1. Open `site/login.html` in browser — form renders with brand styles
2. Submit wrong password — error message appears, no redirect
3. Submit correct credentials — redirects to `dashboard.html`
4. `dashboard.html` loads — brand sidebar + topbar visible, all sections render
5. Open devtools network tab — confirm `POST /api/auth/refresh` fired on load
6. Hard-refresh `dashboard.html` — confirm still logged in (refresh cookie works)
7. Click logout — redirects to `login.html`
8. Navigate directly to `dashboard.html` after logout — redirects to `login.html`

**Full E2E matrix (Commit 10):**

| Scenario | Expected |
|---|---|
| Valid login | Redirect to dashboard, data loads |
| Wrong password | "Invalid email or password" inline error |
| Rate limit (5 attempts) | "Too many attempts" inline error |
| Dashboard hard refresh within 30 days | Stays logged in, data reloads |
| Dashboard hard refresh after 30 days | Redirect to login |
| Token expires mid-session | `authedFetch` silently calls refresh, retries request |
| Railway down | Empty-state cards in all data sections, no JS errors |
| Activate with valid token | "Domain active" success state |
| Activate with expired token | "Link expired" error state |
| Activate with already-used token | "Already activated" error state |
| Logout | Cookie cleared, redirect to login |
| Direct nav to /dashboard.html while logged out | Redirect to login |

---

### 12.7 Rollback plan

Dashboard B (`customers.advocatemcp.com/dashboard`) remains live throughout Phase D. If any Phase D commit introduces a regression or the new dashboard is unusable:

1. Update the marketing site nav link from `dashboard.html` back to `https://customers.advocatemcp.com/dashboard` — single-line edit in `site/index.html`
2. Deploy: `wrangler pages deploy site --project-name=advocatemcp-site --branch=main`
3. Customers retain full access via the worker dashboard

No worker code, D1 schema, or Railway backend changes are made during Phase D, so worker rollback is not needed.

Per-commit rollback: `git revert <commit>` + redeploy. Each commit is self-contained (one page or one section at a time) so reverting is surgical.

---

### 12.8 Open questions

**Q1 (answered): Does `SameSite=Strict` block cross-origin refresh cookie?**
No. `advocatemcp.com` and `customers.advocatemcp.com` share eTLD+1 `advocatemcp.com`. Per the SameSite spec, requests between subdomains of the same eTLD+1 are "same-site" even when cross-origin. With `credentials: 'include'`, the `amcp_refresh` cookie IS sent on the `POST /api/auth/refresh` call from `advocatemcp.com` to `customers.advocatemcp.com`.

**Q2 (open): Should `GET /api/client/me` return the current api_key?**
Needed for: Settings section to show customers their current key (masked) with a copy button.
Requires: A one-line addition to `apiMe` in `worker/src/routes/portal.ts`.
Constraint: Any worker change is outside Phase D scope.
Status: Phase D Settings section ships with rotate-only; show/copy of current key deferred.

**Q3 (resolved in Phase D): Domains section ships as stub.**
A `GET /api/client/domains` worker endpoint is not built in Phase D. The Domains section shows a
"domain routing configured" message and a link to `activate.html`. A real view with activation
status, CNAME target, and TXT verification record is Phase E or later.

---

### 12.9 Scope boundaries

**Phase D owns:**
- `site/login.html`
- `site/dashboard.html`
- `site/activate.html`
- `site/js/dashboard-auth.js`
- `site/js/dashboard-overview.js`
- `site/js/dashboard-requests.js`
- `site/js/dashboard-clicks.js`
- `site/js/dashboard-bots.js`
- `site/js/dashboard-recs.js`
- `site/js/dashboard-settings.js`
- `site/js/dashboard-activate.js`
- Minor nav link update in `site/index.html` (pointing to `dashboard.html`)

**Phase D does not touch:**
- `worker/src/` — any file (portal, authApi, dashboard, routes, index)
- `server/src/` — any Railway backend file
- D1 schema, KV namespaces, Wrangler secrets
- `site/onboarding.html`, `site/onboarding/complete.html`, `site/terms.html`, `site/privacy.html`, `site/dpa.html`
- Bot detection, attribution token format, MCP server

**Phase E (future, not this session):** Delete `worker/src/routes/dashboard.ts` and update `worker/src/routes/portal.ts` to redirect `/dashboard` to `https://advocatemcp.com/dashboard.html`. Requires Cameron approval and a separate session.

---

*Section 12 added 2026-04-11. Pre-work commit before Phase D implementation begins.*

---

### 12.10 Phase D completion record

Phase D fully implemented 2026-04-12. Nine commits on branch `claude/consolidate-dashboard-m14cz`:

| Commit | Hash | Description |
|---|---|---|
| Docs | `1356c31` | Section 12 appended to this document |
| 1 | `50e5943` | `site/login.html` + `site/js/dashboard-auth.js` |
| 2 | `5badd30` | `site/dashboard.html` shell |
| 3–6 | `831767f` | All six section JS modules |
| 7 | `70c8f1a` | E2E verification fixes (3 bugs fixed) |
| 8 | `8ca2e8c` | `site/activate.html` + `site/js/dashboard-activate.js` |
| 9 | *(this commit)* | Domains stub + docs update |

**Files shipped:**
- `site/login.html` — brand login page
- `site/dashboard.html` — 7-section dashboard (Overview, AI Requests, Referral Clicks, Bot Activity, Recommendations, Settings, Domains)
- `site/activate.html` — domain activation with DNS record display
- `site/js/dashboard-auth.js` — `window.AMCP` auth module
- `site/js/dashboard-overview.js` — Overview section
- `site/js/dashboard-requests.js` — AI Requests section
- `site/js/dashboard-clicks.js` — Referral Clicks section
- `site/js/dashboard-bots.js` — Bot Activity section (includes 7×24 heatmap)
- `site/js/dashboard-recs.js` — Recommendations section
- `site/js/dashboard-settings.js` — Settings section with API key rotate
- `site/js/dashboard-activate.js` — Activation page logic

**To deploy:** `wrangler pages deploy site --project-name=advocatemcp-site --branch=main` (run from repo root or any directory — the deploy command uses the `site/` path explicitly).

**Remaining before Phase E:**
- Update nav link in `site/index.html` from `#dashboard` to `/dashboard.html`
- Deploy to Cloudflare Pages
- Verify login → dashboard flow end-to-end in production
- Phase E: redirect `customers.advocatemcp.com/dashboard` → `advocatemcp.com/dashboard.html`

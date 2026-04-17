# Advocate — Website Design System

This document captures the visual language introduced in the 2026 redesign so
future changes stay consistent. All of it sits on top of the existing `site/`
markup — no copy, no IA, no content was changed. Only the *feel* was elevated.

The reference aesthetic is Vercel's homepage: depth, layering, soft glow,
subtle motion, glass, a sense that the page is a living product. Our identity
stays: deep maroon `#7d2550`, warm off-white, near-black. No rainbow, no
prism, ever.

---

## 1. Design tokens

All tokens live as CSS custom properties on `:root` in
`site/index.html` (primary) with the same palette mirrored inside
`site/css/redesign.css` so every page can opt in by linking one stylesheet.

| Token | Value (dark) | Purpose |
|---|---|---|
| `--bg` | `#171614` | Page background — near-black with warm undertone |
| `--surface` | `#1c1b19` | Slightly lifted surface (cards, ticker) |
| `--surface-2` | `#222120` | Second lift level (hover, inputs) |
| `--text` | `#e8e6e3` | Primary foreground, warm off-white |
| `--muted` | `#7a7875` | Secondary text |
| `--accent` | `#7d2550` | **Brand maroon** — the one true accent |
| `--accent-dk` | `#5c1a3c` | Pressed / darker maroon |
| `--accent-bright` | `#a03569` | Hover / glow maroon (lighter tint) |
| `--accent-dim` | `rgba(125,37,80,.12)` | Maroon fill tints (pills, chips) |
| `--accent-ring` | `rgba(125,37,80,.25)` | Maroon borders for accent surfaces |
| `--accent-glow` | `rgba(125,37,80,.35)` | Shadow / glow bloom color |
| `--border` | `#393836` | Structural border |
| `--border-accent` | `rgba(168,41,58,.4)` | Borders that want to feel electric |
| `--glass-bg` | `rgba(26,13,16,.6)` | Glass panel fill |
| `--glass-blur` | `20px` | Glass panel backdrop blur |

Light theme keeps the same `--accent` and softens everything else
(see `[data-theme="light"]` block in `site/index.html`).

### Typography

- Body: **General Sans** (400/500/600) via Fontshare
- Display & italic: **Instrument Serif** via Google Fonts
- Mono (JSON/code): native system mono stack

### Radii

`4 · 8 · 12 · 16` (`--r-sm` → `--r-xl`). Glass panels use `--r-xl`,
pills use `100px`.

---

## 2. Layout rules

1. **Full-bleed sections.** Every major section (`.ln-hero`, `.ln-outcomes`,
   `.ln-price`, `.ln-final-cta`, `.rd-network`, `.ln-footer`) spans the full
   viewport width. Backgrounds, gradients, and glows reach the edges.
2. **Inner content width.** The *content* inside a full-bleed section is
   constrained by `.rd-container` (max-width ~1280px) for readability —
   wider than the old 1100px so the page breathes.
3. **Never cage content** in a narrow centered box the way Vercel does.
   Visual treatments always extend edge-to-edge; only the text/grid layout
   is width-capped.
4. **Gutters.** 40px desktop, 20px mobile. Never less than 20px on any
   viewport.

---

## 3. Core components

### Glass panel (`.rd-glass`)
Translucent card with a blurred backdrop, maroon-tinted hairline border,
and a soft inner accent glow. Use for analytics mocks, pricing cards,
case study cards, dashboard widgets.

```
background: var(--glass-bg);
backdrop-filter: blur(var(--glass-blur)) saturate(140%);
border: 1px solid var(--border);
border-radius: var(--r-xl);
box-shadow:
  0 1px 0 rgba(255,255,255,.04) inset,
  0 24px 60px rgba(0,0,0,.45),
  0 0 0 1px var(--border-accent) inset;
```

On hover (when interactive): lift 4px, intensify `--accent-glow` in the
box-shadow. Always preserve keyboard focus visibility.

### Glow halo (`.rd-halo-*`)
Radial gradient background layers used as full-bleed wallpaper behind
sections. Three intensities:
- `.rd-halo-soft` — 12% maroon at center, for utility sections
- `.rd-halo-med` — 18% maroon, for marquee sections (pricing, CTA)
- `.rd-halo-hot` — 28% maroon, for hero and network centerpiece

### Grain overlay (`.rd-grain`)
Fixed-position SVG fractal-noise at 3% opacity, `pointer-events: none`,
on top of the whole page. Kills gradient banding on OLED displays without
calling attention to itself.

### Terminal chrome (`.rd-term`)
Reskin of the existing `.ln-mock` when the content is code or structured
data. Adds a subtle maroon border glow, a traffic-light dot row, and a
title-bar font treatment. Syntax colors:
- keys → `var(--accent)`
- strings → `var(--text)`
- punctuation → `var(--muted)`

### Pill tab (`.rd-tab`)
Pill-shaped button for tab bars. Inactive: transparent fill, muted text.
Active: maroon-to-transparent gradient fill, soft outer glow, accent text.
Panels cross-fade at 150ms (not hard-cut).

### CTA button
The existing `.btn-primary` class is extended with a soft maroon glow
(`box-shadow: 0 6px 22px var(--accent-glow)`), and on hover the button
lifts 2px while the glow intensifies.

---

## 4. Motion

Every motion rule must be conditional on `@media (prefers-reduced-motion:
no-preference)`. In `reduce` mode, animations collapse to an opacity fade
only, or are disabled entirely.

| Pattern | Timing | Where |
|---|---|---|
| Scroll-in fade-up | 400ms ease, 20px Y | `.fade-up` — already shipped |
| Hover lift | 180ms ease-out, -4px Y | Cards |
| Bar fill | 900ms ease-out | Analytics bars (via IntersectionObserver) |
| Tab cross-fade | 150ms linear | Industries tabs |
| Hero rotation | 0.08 rad/s idle on Y | Three.js hero logo |
| Arc pulse | 2.4s loop, staggered | Network constellation |

### WebGL gating
WebGL scenes (hero logo, network constellation) only initialize when:
1. `window.matchMedia('(prefers-reduced-motion: no-preference)')` matches
2. `window.innerWidth >= 900` (tablet/desktop)
3. The section is intersecting the viewport (IntersectionObserver, 200px
   rootMargin so it's ready just-in-time, not on first paint)

Otherwise, a static fallback renders in the same slot:
- Hero → the existing Perplexity-style answer card (already in markup)
- Network → inline SVG placeholder (`.rd-network-fallback`)

---

## 5. Hero — Floating logo centerpiece

Location: `.ln-hero` section on `index.html`.

**Three.js scene:**
- Three stacked `PlaneGeometry` meshes (1:1 aspect) using `icon-1024.png`
  as a transparent texture, Z-offset 0.05 unit apart.
- Each layer: `MeshPhysicalMaterial` with `transmission: 0.85`,
  `roughness: 0.15`, `thickness: 1.2`, `ior: 1.5`, `clearcoat: 1.0`.
  Additive blend for the front-most layer to get the "bubble" sheen.
- Subtle maroon tint in `material.color` (desaturated) so light picked up
  by the glass carries the brand.
- Rim light from behind in `--accent`, faint white directional from
  above-right, low ambient maroon point light underneath.
- Idle rotation on Y-axis (0.08 rad/s). Mouse-parallax tilt up to ~8°.
- Sits *behind* the hero headline and CTAs — brightness capped so text
  never fights the glass.

**Background:**
- `.rd-halo-hot` behind the hero, full-bleed.
- `.rd-grain` global overlay.
- Optional 8-second horizontal beam sweep (CSS keyframe on a pseudo-
  element; `reduce` disables it).

The scene file is `site/js/hero-scene.js`, loaded as a `<script type=
"module">` and dynamically `import()`ing `three` only when the gating
conditions above are satisfied. That keeps the critical path clean and
ensures mobile users get zero Three.js bytes.

---

## 6. Network constellation — Mid-page centerpiece

Location: new `section.rd-network`, inserted between the analytics
feature row and the lead-routing feature row on `index.html`.

- Full-bleed, ~90vh, dark.
- Center: the same extruded-glass Advocate mark, smaller, locked in place.
- Five orbiting nodes labelled Claude / ChatGPT / Perplexity / Gemini /
  Copilot, using the simpleicons.org marks already on the site.
- Maroon arcs shoot from each orbiting node into the logo (AI → profile),
  then arc outward from the logo to small lead dots scattered near the
  edges (profile → lead).
- Arc pulses travel along the curve; opacity fades in/out on staggered
  intervals so the scene feels alive but never chaotic.
- Bloom post-processing (`UnrealBloomPass`) for the electric feel.
- Faint drifting maroon-tinted particles (200–400) in the background.

**Mobile fallback:** `.rd-network-fallback` — inline SVG showing the
same topology statically. No animation.

---

## 7. Section-by-section visual treatment

All copy untouched — these are class-level CSS overlays.

| Section | Treatment |
|---|---|
| JSON preview (`.ln-feat-row` #1) | `.rd-term` chrome, grid wallpaper, slow vertical bob |
| Analytics dashboard mock (`.ln-feat-row` #2) | `.rd-glass`, bar widths animate on scroll via `IntersectionObserver` |
| Referral flow (`.ln-feat-row` #3) | Arrows gain animated maroon pulse loop |
| Capabilities grid (`.ln-cap-grid`) | 1px maroon top-edge accent line per card, hover glow-lift |
| Industries tabs (`.ln-tab-bar`) | Pill `.rd-tab`, panel cross-fade |
| Customer stories (`.ln-case`) | `.rd-glass`, large stat numbers get maroon gradient text |
| Pricing (`.ln-price-card.pop`) | Elevated 8px, maroon glow border, CTA with lift |
| Final CTA (`.ln-final-cta`) | Background echoes network (arcs only, no logo), full-bleed |
| Footer | Hairline top border + faint halo behind wordmark |

---

## 8. Dashboard

Same design language extends to the authenticated app (`site/dashboard.html`
and the embedded `#page-dashboard` inside `index.html`).

- Sidebar → glass panel, active item gets a 2px maroon left border + soft
  background glow.
- Top bar → thin translucent strip with a maroon underline hairline.
- Stat cards → `.rd-glass`, numbers use the accent color.
- Tables → borders soften to `--border-accent` hairlines; row hover gets a
  faint maroon wash.
- Buttons → share the marketing-site CTA styling.
- Modals → `.rd-glass` panel over a blurred backdrop.

---

## 9. Performance budget

- Three.js + scenes combined: **< 150KB gzipped**. Achieved by importing
  only what we use from `three/examples/jsm/…` and loading the module on
  demand.
- LCP regression target: **≤ +200ms** vs. pre-redesign.
- Target framerate: 60fps on a 2020-era laptop, 30fps+ on mid-range phone
  (or static fallback).
- Mobile (< 900px or `prefers-reduced-motion: reduce`) gets zero WebGL.

---

## 10. Files touched

- `advocate-website-design.md` — this doc
- `site/css/redesign.css` — new global layer (glass, glow, grain, network,
  terminal chrome, pill tabs)
- `site/js/hero-scene.js` — Three.js hero, lazy-loaded
- `site/js/network-scene.js` — Three.js constellation, lazy-loaded
- `site/index.html` — new `<link>` to `redesign.css`, new `<section
  class="rd-network">` inserted between feature rows 2 and 3, hero markup
  gets a `<canvas id="hero-canvas">` sibling
- `site/dashboard.html`, `site/login.html`, `site/activate.html`,
  `site/onboarding.html`, `site/privacy.html`, `site/terms.html` — each
  adds the same `<link>` so the design system applies consistently
- `site/onboarding/complete.html` — same `<link>`

Nothing in `worker/`, `server/`, or the WordPress plugin changes.

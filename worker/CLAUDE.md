# AdvocateMCP Worker — Agent Instructions

## Design System (Read Before Editing Any Page Handler)

**Single source of truth**: [`src/routes/sharedLayout.ts`](src/routes/sharedLayout.ts)

All HTML page handlers in this worker share one design system. The tokens,
header chrome, footer, and theme-toggle script live in `sharedLayout.ts` and
**must not** be duplicated or forked in any other file.

### Rules for UI changes

When editing `demo.ts`, `onboardPage.ts`, or adding a new page handler that
renders HTML:

1. **Always import from `sharedLayout.ts`**:
   ```typescript
   import {
     BASE_TOKENS_CSS,
     BASE_LAYOUT_CSS,
     renderHeader,
     renderFooter,
     themeToggleScript,
   } from "./sharedLayout";
   ```

2. **Emit shared CSS in `<head>`** before any page-specific `<style>` block:
   ```html
   ${BASE_TOKENS_CSS}
   ${BASE_LAYOUT_CSS}
   <style>/* page-specific rules here — use var(--...) only */</style>
   ```

3. **Use `renderHeader()` for the header** — never write raw `<header class="hdr">` markup.

4. **Use `renderFooter()` for the footer** — same rule.

5. **Include `${themeToggleScript()}` before `</body>`** on every page.

6. **NO hardcoded hex colors** in page-specific styles. Always use CSS variables:
   - `var(--bg)`, `var(--bg2)`, `var(--bg3)` — backgrounds
   - `var(--text)`, `var(--sub)`, `var(--muted)` — text
   - `var(--border)`, `var(--border2)` — borders
   - `var(--green)`, `var(--green2)`, `var(--green3)` — brand/success
   - `var(--blue)`, `var(--blue-bg)`, `var(--blue-border)` — info/links
   - `var(--red)`, `var(--yellow)`, `var(--orange)` — semantic
   - `var(--font)`, `var(--mono)` — type

   See `sharedLayout.ts` lines 15–34 for the full palette.

7. **Exceptions** (the only places raw hex is allowed in route files):
   - `<meta name="theme-color">` browser hints
   - `color:#fff` on solid-background buttons (white-on-green stays white in both modes)
   - JSON syntax-highlight classes (`.jk`, `.js`, `.jb`, `.jn`) where the hex is semantic, not thematic — provide both dark and `html.light` overrides
   - Any new exception must be justified with an inline comment.

### Adding a new color

If a page genuinely needs a new color, **add it to `sharedLayout.ts`** inside
both `:root` and `html.light`, then reference it via `var(--new-name)` in the
page styles. Never inline a new hex in a page file.

### Why

Before `sharedLayout.ts` existed, `/demo` and `/onboard` drifted into three
different style systems with different headers, different logos, and no
consistent theme toggle. The user reported the pages "don't look like they
connect". This file is the guardrail — follow it.

### Out of scope (for now)

`src/routes/portal.ts` (dashboard + login + admin) still uses its own styles.
Migrate it to `sharedLayout.ts` in a follow-up pass once the tokens prove
stable on `/demo` and `/onboard`.

## Deploying

> **CRITICAL**: All `wrangler` commands MUST be run from `advocatemcp/worker/`, never from the repo root `advocatemcp/`. The repo root used to contain a stale `wrangler.toml` pointing at a phantom `advocate-worker` — it's now renamed to `wrangler.toml.orphan-do-not-use`. If you ever see that file reappear, delete it.

```bash
cd advocatemcp/worker      # ← always start here
npx tsc --noEmit           # typecheck
npx wrangler deploy        # deploy to customers.advocatemcp.com
```

## Stripe secrets (set from `worker/` directory ONLY)

- `STRIPE_SECRET_KEY` — `sk_test_...` or `sk_live_...`
- `STRIPE_WEBHOOK_SECRET` — `whsec_...` (mode-specific — test-mode whsec ≠ live-mode whsec)
- `STRIPE_PRICE_ID_BASE` — $100/mo (mode-specific — test-mode price_id ≠ live-mode price_id)
- `STRIPE_PRICE_ID_PRO` — $250/mo (mode-specific)

**All four secrets must be in the same mode** (all test OR all live). Mixing modes produces 400 "No such price" errors from Stripe.

To verify which mode is loaded at runtime, hit `POST /api/onboard/public` and watch `wrangler tail` — the `stripe_key_probe` log line prints the first 12 chars of each secret, which reveals the mode (`sk_test_` vs `sk_live_`) without leaking the secret. Remove that log after verification.

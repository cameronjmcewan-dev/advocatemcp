# Enterprise honesty pass — design (Apr 27 2026)

## Context

Three Pricing-page promises and one cross-subdomain UX gap need to land before any real Enterprise tenant signs up. The Pricing copy currently advertises features that aren't built (or only half-built); navigating from the dashboard back to `advocatemcp.com` makes a logged-in customer look logged out. This spec covers the full "Enterprise feels real" pass.

**Out of scope:** SSO/SCIM (defer until a customer asks), audit logs (defer), per-resource ACLs (3-role model is sufficient for SMB+small Enterprise targets), separate Enterprise dashboard (one dashboard, plan-gated).

**Approval directives baked into this spec:**

- Role model: 3 roles (owner / editor / viewer)
- Per-location data: full data-model migration (`location_id` on reservations, click_events, revenue_events) + agent-side stamping
- Pricing copy: "Custom integrations on request — bring us your stack" / "Talk to us" / drop the misleading "+ custom" suffix on revenue attribution
- Cross-subdomain auth: subdomain-scoped cookie + auth-check fetch from marketing pages

---

## Section 1 — Team accounts (1.5–2 days)

### Roles

| Role | Permissions |
|---|---|
| **Owner** | Billing, team management, profile, locations, revenue config, dashboards. Created automatically when the Stripe checkout completes. |
| **Editor** | Profile, locations, revenue config, dashboards. **Cannot:** change billing, manage team. |
| **Viewer** | Read-only dashboards. **Cannot:** edit anything. |

Plan caps from the comparison table:
- `base` → 1 (the owner only — no invites)
- `pro` → 5 total (1 owner + 4 invitees)
- `enterprise` → unbounded

### Auth flow

Magic-link invite, mirrors the existing activation-token pattern.

1. **Owner** clicks "Invite team member" in Settings → Team card. Provides email + role.
2. Worker `POST /api/client/team/invite`:
   - Validates: caller is owner, plan-cap not exceeded, target email not already a member
   - Creates `users` row with `pending_invite=1` flag and no password hash
   - Creates `user_business_access` row with the chosen role
   - Mints HMAC-signed invite token (7-day TTL, one-shot, claims: `{user_id, business_slug, exp}`)
   - Sends Resend email "Cameron invited you to AdvocateMCP for {Business Name}" with link `https://customers.advocatemcp.com/team-accept?t=<token>`
3. **Invitee** clicks link → lands on `team-accept.html`. Page extracts `t=`, validates via `POST /auth/team-accept` (worker checks HMAC + exp + one-shot consumption), shows a "Set your password" form.
4. Submit → password hashed via existing PBKDF2-100k pattern, stored on the `users` row, `pending_invite=0`, session cookie issued, redirect to `/dashboard`.

Invite-token reuse: same as activation tokens — `consumed_at` column on `users` (or a new `invite_consumed_at`) ensures one-shot. Re-clicking the link after acceptance returns 410 Gone.

### Role enforcement

New `requireRole(...allowedRoles)` middleware factory in `worker/src/auth.ts`. Wraps `getSessionFromRequest` — when the session resolves a user, it joins to `user_business_access` and stamps the role onto the request. Endpoints that mutate state declare which roles can call them:

```ts
// Example wiring
if (pathname === "/api/client/locations" && method === "POST") {
  return requireRole(["owner", "editor"], apiLocationsAdd)(request, env);
}
if (pathname === "/api/client/team/invite" && method === "POST") {
  return requireRole(["owner"], apiTeamInvite)(request, env);
}
```

### Settings UI

New "Team" card on the Settings page, between "Locations" and "Revenue tracking":

- Header: `Team · X of Y members · {plan} plan` (right-aligned)
- Member list: avatar (initials), email, role chip (owner = maroon, editor = sage, viewer = muted), "Edit role" / "Remove" buttons (hidden for self)
- Invite form (visible only to owner): `[email input] [role dropdown: Editor / Viewer] [Invite button]`
- Edit-role inline: clicking role chip opens dropdown; promoting to owner triggers a confirm ("Transfer ownership? You'll become an editor.")
- Remove: confirms + revokes session immediately
- Plan-cap state: when capped, the invite form shows `Upgrade to Enterprise to invite more team members` linked to `/Pricing`

### Critical files

- `worker/src/lib/inviteToken.ts` (new) — HMAC-signed invite token, clones `activation-token.ts`
- `worker/migrations/0011_team_invites.sql` (new) — adds `pending_invite`, `invite_consumed_at` to `users`
- `worker/src/routes/team.ts` (new) — invite, accept-and-set-password, list, update-role, remove
- `worker/src/routes/portal.ts` — wires 5 new endpoints + applies `requireRole` to existing mutating endpoints
- `worker/src/auth.ts` — adds `requireRole(...)` middleware factory
- `site/team-accept.html` (new) — set-password landing page
- `site/js/v2/settings.js` — new Team card

---

## Section 2 — Per-location dashboard drill-down (2–3 days)

### Data model migrations

Both server SQLite + worker D1 (additive):

```sql
ALTER TABLE reservations    ADD COLUMN location_id TEXT;
ALTER TABLE click_events    ADD COLUMN location_id TEXT;
ALTER TABLE revenue_events  ADD COLUMN location_id TEXT;

CREATE INDEX idx_reservations_loc   ON reservations(business_slug, location_id, requested_at);
CREATE INDEX idx_click_events_loc   ON click_events(business_slug, location_id, ts);
CREATE INDEX idx_revenue_events_loc ON revenue_events(business_slug, location_id, occurred_at);
```

No FK to `locations.id` — soft reference so a location deletion doesn't cascade-delete a year of analytics. Orphan rows just don't show up in any single-location filter; they appear in "All locations".

### Agent stamps location_id

Today `server/src/agent/query.ts` calls Claude with the `Locations:` block in the system prompt. After the response generates, the agent picks (implicitly) which location was relevant. To capture that:

1. Append a small instruction to the system prompt: *"If your answer references a specific location from the list above, set `location_id` in the structured-output footer to that location's id. If the answer is brand-wide or no specific location applies, leave it null."*
2. Use Anthropic's structured-output mode (or a simple `<location_id>...</location_id>` tag) to extract the choice from the response.
3. When a derived event (reservation hold, click event, revenue event) is created from this query, stamp the extracted `location_id` on the row.

When the model can't pick a location confidently, `location_id = NULL` and the row attributes to "All locations". Forward-only — historical rows stay NULL.

### Topbar selector

`site/assets/dashboard-chrome.js` already renders the topbar with a date-range button. Adding a new dropdown next to it: `📍 All locations ▾` opening to the location list pulled from `/api/client/locations`. Selection persists in `localStorage` (`amcp_selected_location_id`) so navigating between sections doesn't reset.

When selected, every fetch in the dashboard appends `?location_id=<id>`. The router emits a custom `amcp:location-changed` event so all open panels (Overview, AI Requests, Bot Activity, Recommendations) re-fetch.

### Server endpoint extension

Every analytics endpoint that's currently `slug`-keyed gains an optional `?location_id=` query param:

- `/agents/:slug/analytics` — filters reservations + clicks + queries
- `/agents/:slug/revenue-summary` — filters revenue_events + the confirmed-reservation count for AOV-estimated path
- `/agents/:slug/recommendations` — filters by location when applicable

Backward-compatible: omitted = aggregate across all locations (current behavior).

### Critical files

- `server/src/db/migrations/032_per_location_data.sql` (new)
- `worker/migrations/0010_per_location_data.sql` (new)
- `server/src/agent/query.ts` — system prompt extension + structured-output extraction
- `server/src/agent/builder.ts` — already injects Locations: block (Phase 2 work, no change)
- `server/src/lib/revenue.ts:computeRevenueWindow()` — accept optional `locationId`
- `server/src/routes/agent.ts` — extend `/analytics`, `/revenue-summary` with `location_id` filter
- `worker/src/routes/portal.ts` — pass-through `?location_id` to Railway calls
- `site/assets/dashboard-chrome.js` — topbar location dropdown + `amcp:location-changed` event
- `site/js/v2/overview.js`, `activity.js`, `clicks.js`, `bots.js`, `radar.js` — read selected `location_id`, append to API calls, refetch on event

---

## Section 3 — Honest Pricing copy (15 minutes)

Three text edits to `site/Pricing.html`:

| Location | Current | New |
|---|---|---|
| Enterprise feature bullets | `Custom integrations (POS, CRM, etc.)` | `Custom integrations on request — bring us your stack` |
| Comparison-table row "Custom integrations (POS, CRM)" → Enterprise column | `<div class="y">✓</div>` | `<div class="y">Talk to us</div>` |
| Comparison-table row "Revenue attribution" → Enterprise column | `<div class="y">✓ + custom</div>` | `<div class="y">✓</div>` |

No FAQ updates needed. No new links. The honest positioning still differentiates Enterprise via the human commitments (success manager, white-glove, quarterly reviews, priority phone) and the unlimited locations + team caps that ARE real software.

---

## Section 4 — Cross-subdomain logged-in state (~1 day)

### Cookie scope migration

The portal session cookie is currently set with `Domain=customers.advocatemcp.com` (host-only). Change to `Domain=.advocatemcp.com` so both subdomains receive it. Single line in `worker/src/auth.ts` where the `Set-Cookie` header is built.

**Migration cost:** existing logged-in users will need to log in once after the deploy (the host-only cookie and the new domain-scoped cookie are different cookies; the new sign-in writes only the domain-scoped one). Acceptable pre-outreach — there are <5 active sessions today.

### CORS allowance

`/api/client/me` (and any other endpoint the marketing site needs to read) gains `https://advocatemcp.com` in its CORS origin allowlist. The endpoint already returns 401 for unauthenticated callers — that's the desired no-op response when the marketing site asks "are they logged in?" and they aren't.

### Marketing-side auth-check

New `site/js/marketing-auth.js` (~80 lines, vanilla JS):

1. On DOMContentLoaded, fetch `https://customers.advocatemcp.com/api/client/me` with `credentials: 'include'`.
2. If 200 → render the logged-in nav state:
   - Replace `[Sign in] [Get started]` cluster with `[avatar][▾]` dropdown
   - Avatar shows user's email initial in a maroon circle
   - Dropdown contains: `Dashboard →`, `Settings →`, `Billing →`, divider, `Sign out`
   - All links target `https://customers.advocatemcp.com/...` — cookie travels via subdomain scope, no login bounce
3. If 401 → no-op (existing nav stays)
4. Sign-out click → `POST https://customers.advocatemcp.com/auth/logout` with credentials, then `location.reload()`

### Marketing page wiring

Each marketing page picks up the script via one line before `</body>`:

```html
<script src="/js/marketing-auth.js" defer></script>
```

Pages affected: `index.html`, `Pricing.html`, `Features.html`, `FAQs.html`, `Contact.html`, `Industries.html`, `methodology.html`, `mcp.html`, `audit.html`. Skip `terms.html`, `privacy.html`, `404.html` (no nav).

### Critical files

- `worker/src/auth.ts` — `Domain=.advocatemcp.com` on session cookie
- `worker/src/routes/portal.ts` — extend `/api/client/me` CORS to allow `https://advocatemcp.com`
- `site/js/marketing-auth.js` (new) — auth-check + nav swap
- 9 marketing HTML pages — one-line script tag

---

## Cross-cutting concerns

### Reusable existing helpers

- `worker/src/lib/activation-token.ts` — clone for invite tokens (Section 1)
- `worker/src/lib/crypto.ts` — HMAC-SHA256 helpers (Section 1)
- `server/src/lib/revenue.ts:computeRevenueWindow()` — extend with `locationId` param (Section 2)
- `server/src/repos/locations.ts` — listLocations, used by topbar selector (Section 2)
- `worker/src/lib/resend.ts:sendEmail()` — invite emails (Section 1)
- Existing `site/js/v2/settings.js` Locations card pattern — clone shape for Team card (Section 1)
- Existing date-range button in `dashboard-chrome.js` — clone styling for location selector (Section 2)

### Order of work

Sequence matters because Section 1's `requireRole` middleware gets applied to existing mutating endpoints (locations, revenue) — Section 2 (per-location filtering) is downstream of that gating.

1. **Section 3 first** (15 min) — Pricing copy edits. Trivial, ships immediately, removes the false claims before anything else.
2. **Section 4 second** (~1 day) — cross-subdomain auth. Lands the cookie scope change so team-account invitees can later land on the marketing site or dashboard interchangeably and stay logged in. No upstream dependencies.
3. **Section 1 third** (~1.5–2 days) — team accounts. Adds the `requireRole` middleware. Owner-promoted-on-checkout backfill for existing tenants happens via a one-line migration.
4. **Section 4.5 — extend cookie work for new sessions** — Section 1's password-set flow uses the same Section-4 cookie writer, so the scope is already correct when the invitee lands on the dashboard.
5. **Section 2 last** (~2–3 days) — per-location data model + agent stamping + topbar dropdown. The most code surface; safest as the last layer added.

Total: ~5–7 working days for solo founder.

### Verification

**Section 1 (team accounts):**
- Owner invites editor@example.com → email arrives within 60s, link works once, password set, lands on dashboard with editor role
- Editor tries to call `/api/client/team/invite` → 403 with `forbidden_role`
- Plan cap: 5th invite on Pro → 402 with upgrade CTA
- Remove team member → their session terminated, can't access dashboard
- Promote editor → owner triggers confirm; on accept, original owner becomes editor
- Magic-link replay (click after consume) → 410 Gone with "Already accepted"

**Section 2 (per-location):**
- Add 3 locations to a Pro tenant; query the bot with "what are your hours in Round Rock" → reservation row gets `location_id = <round-rock-id>`
- Topbar dropdown shows 3 locations + All; selecting Round Rock → all KPIs scope to that location only
- Switch to Austin → KPIs change; localStorage retains Austin across page navigation
- Revenue summary endpoint with `?location_id=<id>` → returns only that location's revenue events
- Backward compat: Pro tenant with one location, omit query param → dashboard renders identically to pre-feature

**Section 3 (Pricing copy):**
- View `advocatemcp.com/Pricing` → "Custom integrations on request" appears in Enterprise bullets, comparison table shows "Talk to us" for the integrations row, revenue attribution row shows just `✓`

**Section 4 (cross-subdomain):**
- Log into `customers.advocatemcp.com/dashboard`
- Navigate to `advocatemcp.com/Pricing` → top-right shows avatar dropdown, not Sign in / Get started
- Click avatar → dropdown opens with Dashboard / Settings / Billing / Sign out
- Click Dashboard → lands on dashboard already authenticated (no login bounce)
- Click Sign out → marketing nav reverts to logged-out state, dashboard becomes unreachable

### Risks

| Risk | Mitigation |
|---|---|
| Section 4 cookie migration locks out existing sessions | Acceptable: <5 active sessions pre-outreach. Post-deploy, anyone affected logs in once. |
| Section 1 invite email lands in spam | DKIM + SPF on `advocatemcp.com` already verified for Resend (Phase 1 work). Subject line "Cameron invited you to AdvocateMCP" is human-warm, not bulk-marketing. |
| Section 2 agent doesn't reliably pick `location_id` | Default to NULL when uncertain — never fabricate. Worst case is forward-only "All locations" attribution, recoverable later by re-prompting. |
| Section 1 + 2 schema changes conflict on a busy migration runner | Migrations are independent (`0011_team_invites.sql` and `0010_per_location_data.sql`); apply order is deterministic by filename. |
| Pricing copy change accidentally drops the visual differentiation between Pro and Enterprise | Section 3 keeps every other ✓; only the misleading ones change. The honest "Talk to us" still signals "more available than Pro." |

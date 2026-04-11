# Session 2026-04-10 — Phase B: Stripe Checkout Session Unblock

**Session type**: Diagnostic + configuration fix, per Phase B of the rearchitecture plan (`docs/rearchitecture-plan-2026-04-10.md` Section 8).

**Start time**: 2026-04-10, late evening.

---

## Context for future reference

This is a standalone session log. If you're reading this three months from now without the surrounding conversation, here's what you need to know.

- **What Phase B is**: Stripe Checkout Session unblock. As of the start of this session, any customer submitting the 5-step wizard at `https://advocatemcp.com/onboarding.html` received an error when the worker tried to create a Stripe Checkout Session. The error surfaced in the browser as `"Failed to create Stripe Checkout Session"` and blocked the entire paid-signup funnel. No paying customers could complete checkout.

- **What the hypothesis was going in**: The architecture audit earlier on 2026-04-10 (see `docs/rearchitecture-plan-2026-04-10.md` Section 8 Phase B, and the Section 6 notes in the earlier audit conversation) flagged a Stripe secret mode mismatch as the most likely cause — `STRIPE_SECRET_KEY` in one mode (`sk_test_...` or `sk_live_...`) with `STRIPE_PRICE_ID_BASE` or `STRIPE_PRICE_ID_PRO` in the other mode. Stripe's API rejects cross-mode operations with a "No such price" error. A diagnostic probe at `worker/src/routes/stripe.ts:398-407` logs the first 12 characters of each Stripe secret on every `handlePublicOnboard` invocation, specifically so we could catch this.

- **What the actual finding was**: mode mismatch confirmed by Stripe itself. The `stripe_key_probe` log captured `STRIPE_SECRET_KEY` in test mode (`sk_test_51TK` prefix) while the `public_checkout_error` log captured Stripe's own error message: *"No such price: 'price_1TKTqXPrvMJQiRJhIsiSewQB'; a similar object exists in live mode, but a test mode key was used to make this request."* Both `STRIPE_PRICE_ID_BASE` and `STRIPE_PRICE_ID_PRO` were live-mode price IDs paired with a test-mode secret key — Stripe rejected every Checkout Session creation request because cross-mode operations are not allowed. Hypothesis confirmed exactly.

- **What the fix was**: two Stripe secret rotations, both from live mode to test mode, via `cd worker && npx wrangler secret put`. `STRIPE_PRICE_ID_BASE` and `STRIPE_PRICE_ID_PRO` were set to the corresponding test-mode price IDs from the Stripe dashboard's test-mode Products section. `STRIPE_SECRET_KEY` was left unchanged (already correct). `STRIPE_WEBHOOK_SECRET` was left unchanged and **not verified** (prefix is ambiguous between modes, not exercised in this session). Both rotations verified end-to-end with fresh wizard submissions — one for Base plan and one for Pro plan — each of which successfully redirected to a valid Stripe Checkout test-mode page with the correct product name and recurring price. No code changes. No removal of the diagnostic probe. Full details in the Verification and Root cause sections below.

- **Was live mode verified in this session**: **No — deferred.** This session's exit criteria explicitly required test-mode verification only. Live mode verification is a separate sub-task for a subsequent session where Cameron manually issues a real test transaction in the Stripe dashboard, captures the charge, and refunds it. That work requires direct Stripe dashboard access and did not happen tonight.

---

## Diagnostic sequence

Per the approved proposal in the 2026-04-10 session transcript. Steps 0–8.

### Step 0 — Session notes created

This file. Created at the start of the session.

### Step 1 — wrangler tail started

Started `npx wrangler tail --format=pretty` from `worker/` as a background process. Confirmed streaming with "Connected to advocatemcp-worker, waiting for logs..." Tail expires 2026-04-11T07:58:57Z.

### Step 2 — Cameron triggered the failure from browser

Cameron opened `https://advocatemcp.com/onboarding.html` in a fresh incognito window and completed the 5-step wizard with slug `moreland-property-group`, plan `base`, submitted at approximately 2026-04-10 21:12:28 local (2026-04-11 02:12:28 UTC).

---

## Observed log output

Raw capture of the relevant log lines from `wrangler tail` during the reproduction. All secret prefixes are already redacted to the first 12 characters per the existing probe code — that's Stripe-documented safe.

### Request/response envelope

```
OPTIONS https://customers.advocatemcp.com/api/onboard/public - Ok @ 4/10/2026, 9:12:28 PM
POST    https://customers.advocatemcp.com/api/onboard/public - Ok @ 4/10/2026, 9:12:28 PM
```

CORS preflight succeeded. POST body reached the worker. No CORS/DNS issue.

### `stripe_key_probe` — secret prefix diagnostic

```json
{
  "onboarding": true,
  "event": "stripe_key_probe",
  "slug": "moreland-property-group",
  "plan": "base",
  "secret_prefix":         "sk_test_51TK",
  "base_price_prefix":     "price_1TKT",
  "pro_price_prefix":      "price_1TKT",
  "webhook_secret_prefix": "whsec_PCJT"
}
```

- `STRIPE_SECRET_KEY` → **test mode** (`sk_test_` prefix is Stripe's documented test-mode indicator).
- `STRIPE_PRICE_ID_BASE` → prefix alone is ambiguous (Stripe uses `price_` for both modes), but see the Stripe error below which confirms this specific ID is a **live-mode** price.
- `STRIPE_PRICE_ID_PRO` → same prefix pattern as BASE. Mode not directly confirmed by this log, but same account creation pattern strongly implies it's also live-mode.
- `STRIPE_WEBHOOK_SECRET` → prefix alone is ambiguous (`whsec_` for both modes). Mode status unknown. See followups.

### `public_onboard_started` — reached the tenant construction block

```json
{
  "onboarding": true,
  "event": "public_onboard_started",
  "slug": "moreland-property-group",
  "plan": "base",
  "hasExisting": false,
  "hasProfile": true
}
```

Code path proceeded normally through the probe and into the tenant construction + Stripe API call.

### `public_checkout_error` — Stripe's rejection in its own words

```json
{
  "onboarding": true,
  "event": "public_checkout_error",
  "slug": "moreland-property-group",
  "error": {
    "error": {
      "code": "resource_missing",
      "doc_url": "https://stripe.com/docs/error-codes/resource-missing",
      "message": "No such price: 'price_1TKTqXPrvMJQiRJhIsiSewQB'; a similar object exists in live mode, but a test mode key was used to make this request.",
      "param": "line_items[0][price]",
      "request_log_url": "https://dashboard.stripe.com/acct_1TKTSmPrvMJQiRJh/test/workbench/logs?object=req_vTUo9o44WtkjEB",
      "type": "invalid_request_error"
    }
  }
}
```

**Stripe's exact words**: *"No such price: 'price_1TKTqXPrvMJQiRJhIsiSewQB'; a similar object exists in live mode, but a test mode key was used to make this request."*

This is as definitive as diagnosis gets. Stripe is telling us, verbatim, that the price ID we sent exists in live mode but we tried to use it with a test-mode key. The mode drift hypothesis from the architecture audit is confirmed with Stripe as the witness.

---

## Analysis

**Confirmed state** (as of 2026-04-11 02:12:28 UTC, pre-fix):

| Secret | Mode | Evidence |
|---|---|---|
| `STRIPE_SECRET_KEY` | **test** | `sk_test_` prefix |
| `STRIPE_PRICE_ID_BASE` | **live** | Stripe's own error message: "a similar object exists in live mode" |
| `STRIPE_PRICE_ID_PRO` | **live** (inferred) | Same prefix pattern as BASE, same account creation sequence, no evidence of independent rotation |
| `STRIPE_WEBHOOK_SECRET` | **unknown** | Prefix alone does not reveal mode; not exercised in this test so Stripe didn't tell us |

**What Phase B needs to fix**: rotate `STRIPE_PRICE_ID_BASE` and `STRIPE_PRICE_ID_PRO` from their current **live-mode** values to the corresponding **test-mode** values in the Stripe dashboard's test-mode Products section. Per Cameron's mode preference, test mode is the target (not live mode) for this session's verification. Live mode alignment is a separate sub-task for a subsequent session.

**What Phase B does NOT fix**: the webhook secret mode. The webhook secret is only exercised when Stripe POSTs to `/api/stripe/webhook` after a customer actually completes a payment. Phase B's exit criteria only require that a Checkout Session be successfully created and resolve to a valid Stripe Checkout page — it does not require a full payment flow. Webhook mode alignment is a followup.

**Why rotate BOTH BASE and PRO at the same time**: both show the same prefix pattern (`price_1TKT`) and both originated from the same Stripe account creation. The error message only mentions BASE because the test was for `plan: "base"` — the wizard's plan selector sends `"base"` or `"pro"` and the worker code at `stripe.ts:499` picks the matching price ID. If we only rotate BASE and a future customer picks Pro, we'd hit the same error on that plan and need a second rotation + verification round. Rotating both at once saves a round trip.

---

## Fix

### Root cause

*(to be filled in)*

### Proposed fix

*(to be filled in)*

### Secret rotation safety record

#### Rotation 1 — `STRIPE_PRICE_ID_BASE`

- **Secret name**: `STRIPE_PRICE_ID_BASE`
- **Pre-rotation mode**: live (confirmed by Stripe error message: "a similar object exists in live mode, but a test mode key was used to make this request")
- **Pre-rotation value (ID only, non-secret per Stripe docs)**: `price_1TKTqXPrvMJQiRJhIsiSewQB`
- **Post-rotation target mode**: test
- **Rotation executed**: yes, 2026-04-11 UTC, by Cameron via `npx wrangler secret put STRIPE_PRICE_ID_BASE` from `worker/`
- **Worker redeploy confirmed**: yes, automatic on secret update
- **Cameron's confirmation of previous-value capture**: yes — externally captured in a parallel Claude advisory conversation thread (running alongside this Claude Code session). Cameron committed to a post-Phase-B cleanup adding the same value to 1Password with the label `"AdvocateMCP — STRIPE_PRICE_ID_BASE — live mode (rollback Apr 10 2026)"`.

#### Rotation 2 — `STRIPE_PRICE_ID_PRO`

- **Secret name**: `STRIPE_PRICE_ID_PRO`
- **Pre-rotation mode**: live (inferred at rotation time from same prefix pattern as BASE, later confirmed when Cameron captured the specific live-mode ID)
- **Pre-rotation value (ID only, non-secret per Stripe docs)**: `price_1TKTqgPrvMJQiRJhzIi0G99C`
- **Post-rotation target mode**: test
- **Rotation executed**: yes, 2026-04-11 UTC, by Cameron via `npx wrangler secret put STRIPE_PRICE_ID_PRO` from `worker/`
- **Worker redeploy confirmed**: yes, automatic on secret update
- **Cameron's confirmation of previous-value capture**: yes — externally captured in the same parallel Claude advisory conversation thread. Same post-Phase-B cleanup to add to 1Password with the label `"AdvocateMCP — STRIPE_PRICE_ID_PRO — live mode (rollback Apr 10 2026)"`.

#### Deviation from ideal audit protocol (flagged explicitly)

The original proposal specified that Cameron would save each pre-rotation live-mode value in 1Password **before** executing each `wrangler secret put`. In practice, the values were captured in an external AI chat thread (a parallel Claude advisory conversation, not this Claude Code session) rather than written directly to 1Password at rotation time. The 1Password entries are planned as a post-Phase-B cleanup.

**What this does and does not change**:

- **Functional property preserved**: both live-mode price IDs are recoverable from at least one external source if a rollback becomes necessary. The ability to restore the pre-rotation state is not impaired.
- **Audit-trail property weakened**: the rollback values live in two systems (chat thread + future 1Password entry) rather than one canonical place. Anyone reviewing this session six months later would need to know about the chat thread to find the values until the 1Password migration happens.
- **Price IDs are non-secret**: Stripe documents price IDs as public identifiers that can appear in client-side code and URLs. Capturing them in a chat thread is not a secret-leakage concern. If this were `sk_live_...` or a webhook secret, the same drift would be unacceptable.

The deviation is recorded here explicitly so future session reviews can see the gap and the mitigation. The lesson for future rotations: if you're going to capture rollback values, do it directly in the canonical password-manager location at rotation time, so the audit trail has a single source.

Never record the full secret value in this file — only the prefix or the Stripe-side price ID (which is non-secret per Stripe's own docs) and the fact that an external backup was confirmed before rotation.

---

## Verification

Two independent post-fix verifications, one for each rotated price ID.

### Verification 1 — `plan: base` via `STRIPE_PRICE_ID_BASE` (test-mode)

Executed shortly after both rotations landed. Cameron submitted the wizard at `https://advocatemcp.com/onboarding.html` in a fresh incognito window. The form's state carried over from the original failure test so the business name (and therefore the auto-generated slug) remained `moreland-property-group` — unintentional but fine for verification purposes, since the slug is just a tenant identifier.

#### Backend log sequence captured in `wrangler tail`

```json
// stripe_key_probe — post-rotation secret prefixes
{
  "onboarding": true,
  "event": "stripe_key_probe",
  "slug": "moreland-property-group",
  "plan": "base",
  "secret_prefix":         "sk_test_51TK",
  "base_price_prefix":     "price_1TKr",   // ← changed from "price_1TKT" (live mode)
  "pro_price_prefix":      "price_1TKr",   // ← also changed from "price_1TKT"
  "webhook_secret_prefix": "whsec_PCJT"
}

// public_onboard_started — tenant construction reached
{
  "onboarding": true,
  "event": "public_onboard_started",
  "slug": "moreland-property-group",
  "plan": "base",
  "hasExisting": false,
  "hasProfile": true
}

// status_transition — Stripe Checkout session recorded on tenant
{
  "onboarding": true,
  "event": "status_transition",
  "domain": "moreland-property-group.hosted.advocatemcp.com",
  "from": "pending_payment",
  "to":   "pending_payment",
  "detail": "Stripe Checkout created via wizard: cs_test_a1z2rKR2RKduarjZorQ41dkAijjddE3QlifLdfY78G1fOvlFaB9ZyjuiI0"
}

// public_checkout_created — the success log (absent in the pre-rotation run)
{
  "onboarding": true,
  "event": "public_checkout_created",
  "slug": "moreland-property-group",
  "plan": "base",
  "sessionId": "cs_test_a1z2rKR2RKduarjZorQ41dkAijjddE3QlifLdfY78G1fOvlFaB9ZyjuiI0"
}
```

**No `public_checkout_error` event follows.** The happy path ran to completion.

#### Browser-side visual confirmation (from Cameron)

Browser redirected to `https://checkout.stripe.com/c/pay/cs_test_a1z2rKR2RKduarjZorQ41dkAijjddE3QlifLdfY78G1fOvlFaB9ZyjuiI0...` with these visible elements:

- **Orange TEST MODE pill** next to "Cameron McEwan" in the top-left — confirms Stripe rendered in test mode
- **`cs_test_` prefix** in the URL — confirms test-mode session at the Stripe API level
- **Product name**: "Subscribe to Advocate Base"
- **Price**: $100.00 per month
- **Pre-populated contact email**: `asdf@gmail.com` (matching the wizard submission)
- **Full payment method selector** rendering (Card, Link, Amazon Pay, Cash App, Klarna)

No card details were entered. Cameron closed the Stripe tab without attempting payment. The exit criterion was "seeing the Checkout page render with the right product" — satisfied.

**Post-rotation test-mode BASE price ID confirmed from Cameron's Stripe dashboard**: `price_1TKrDjPrvMJQiRJhVDBR83AD`. This resolved to the Advocate Base product Cameron had created in the Stripe test-mode dashboard a few minutes earlier as part of the rotation preparation, with the correct $100/month recurring price.

**Screenshot**: Cameron captured a screenshot of the rendered Stripe Checkout page for his session archive. The screenshot is not embedded in this notes file but exists in Cameron's personal session archive.

### Verification 2 — `plan: pro` via `STRIPE_PRICE_ID_PRO` (test-mode)

Executed immediately after Verification 1 passed. Cameron submitted a fresh wizard in a new incognito window with business name that slugified to `test-phase-b-v2-pro` and explicitly selected **plan Pro** to exercise the PRO rotation independently of BASE.

#### Backend log sequence captured in `wrangler tail`

```json
// stripe_key_probe — post-rotation secret prefixes, Pro plan
{
  "onboarding": true,
  "event": "stripe_key_probe",
  "slug": "test-phase-b-v2-pro",
  "plan": "pro",
  "secret_prefix":         "sk_test_51TK",
  "base_price_prefix":     "price_1TKr",
  "pro_price_prefix":      "price_1TKr",
  "webhook_secret_prefix": "whsec_PCJT"
}

// public_onboard_started — tenant construction reached
{
  "onboarding": true,
  "event": "public_onboard_started",
  "slug": "test-phase-b-v2-pro",
  "plan": "pro",
  "hasExisting": false,
  "hasProfile": true
}

// status_transition — Stripe Checkout session recorded on tenant
{
  "onboarding": true,
  "event": "status_transition",
  "domain": "test-phase-b-v2-pro.hosted.advocatemcp.com",
  "from": "pending_payment",
  "to":   "pending_payment",
  "detail": "Stripe Checkout created via wizard: cs_test_a15P3sObRF1uadjbilMx8VPApRzpojuyHnHH0IzbyS1GUbnshS2Dwi6Wfz"
}

// public_checkout_created — the success log, distinct sessionId from Verification 1
{
  "onboarding": true,
  "event": "public_checkout_created",
  "slug": "test-phase-b-v2-pro",
  "plan": "pro",
  "sessionId": "cs_test_a15P3sObRF1uadjbilMx8VPApRzpojuyHnHH0IzbyS1GUbnshS2Dwi6Wfz"
}
```

**No `public_checkout_error` event follows.** Happy path ran to completion on the Pro plan. Session ID is distinct from Verification 1's `cs_test_a1z2rKR2RKduarjZorQ41dkAijjddE3QlifLdfY78G1fOvlFaB9ZyjuiI0`, confirming a fresh session was created rather than a cached Base result.

#### Browser-side visual confirmation (from Cameron)

Browser redirected to `https://checkout.stripe.com/c/pay/cs_test_a15P3sObRF1uadjb...` with these visible elements:

- **Orange TEST MODE pill** next to "Cameron McEwan" account name — confirms test mode
- **Product name**: "Subscribe to Advocate Pro"
- **Price**: $250.00 per month
- **Payment methods**: Card, Cash App Pay, Klarna, Bank (with $5 back promo)
- **Pre-populated email** from wizard submission
- **Session ID in URL** matches the tail log and is distinct from Verification 1's session ID

No card details, phone number, or payment method selected. Cameron closed the Stripe tab immediately after visual confirmation, per the Phase B exit criteria.

**Screenshot**: captured by Cameron for his session archive, not embedded in this notes file.

### Both rotations independently verified

- **Verification 1 (Base, $100/mo)**: backend log sequence clean, browser redirect confirmed, product + price correct.
- **Verification 2 (Pro, $250/mo)**: backend log sequence clean, browser redirect confirmed, product + price correct, distinct session ID from Verification 1.

Both price IDs are confirmed to be correctly set in test mode on the deployed worker. Both resolve to their corresponding Stripe test-mode products with the correct recurring subscription prices. The mode drift is fully resolved from the worker's perspective.

---

## Root cause summary

The deployed worker had `STRIPE_SECRET_KEY` set to a test-mode secret (`sk_test_51TK...`) while `STRIPE_PRICE_ID_BASE` (`price_1TKTqXPrvMJQiRJhIsiSewQB`) and `STRIPE_PRICE_ID_PRO` (`price_1TKTqgPrvMJQiRJhzIi0G99C`) were both live-mode price IDs. When the wizard at `advocatemcp.com/onboarding.html` called `POST /api/onboard/public`, Stripe rejected the Checkout Session creation request with `resource_missing` — "No such price: ...; a similar object exists in live mode, but a test mode key was used to make this request." The worker propagated Stripe's error as a 502 `"Failed to create Stripe Checkout Session"` to the browser, blocking every paid signup attempt on the marketing funnel.

## Fix description

Two Stripe secret rotations via `cd worker && npx wrangler secret put`, both executed by Cameron with external backups of the pre-rotation live-mode values captured before each rotation (deviation from ideal 1Password-at-rotation-time protocol is documented in the Secret rotation safety record above):

1. `STRIPE_PRICE_ID_BASE`: rotated from `price_1TKTqXPrvMJQiRJhIsiSewQB` (live) to `price_1TKrDjPrvMJQiRJhVDBR83AD` (test, corresponding to the Advocate Base test-mode product at $100/month recurring).
2. `STRIPE_PRICE_ID_PRO`: rotated from `price_1TKTqgPrvMJQiRJhzIi0G99C` (live) to a test-mode value (prefix `price_1TKr...` per the post-rotation `stripe_key_probe` capture — full ID not recorded in these notes, visible in Cameron's Stripe test-mode dashboard).

Each rotation triggered an automatic worker redeploy. Both rotations verified end-to-end as described in Verification 1 and Verification 2 above.

**No code changes were made in this session.** The fix is purely configuration. The diagnostic probe at `worker/src/routes/stripe.ts:398-407` remains in place and is not being removed in this session — its removal is a separate follow-up after the fix holds for a day or two.

---

## Residual concerns and followup items for tomorrow

1. **`STRIPE_WEBHOOK_SECRET` mode is NOT verified in this session.** The `webhook_secret_prefix` in the `stripe_key_probe` log reads `whsec_PCJT` in both pre-rotation and post-rotation captures — same value both times, unchanged by the rotations. Stripe uses the `whsec_` prefix for both test-mode and live-mode webhook signing secrets, so the prefix alone does not reveal which mode it's in. Phase B did not exercise the webhook path (no actual payment was completed), so Stripe never sent a `checkout.session.completed` event that would have confirmed or refuted the webhook secret's mode. **Before any full end-to-end test-mode payment flow is attempted — filling in test card `4242 4242 4242 4242`, completing checkout, watching for the webhook to fire and flip the tenant to `active` — the webhook secret must be verified to be in test mode and rotated to a fresh test-mode value if necessary.** The test-mode webhook secret lives in the Stripe dashboard's test-mode webhooks section under the specific webhook endpoint for `customers.advocatemcp.com/api/stripe/webhook`. If the current worker-side `STRIPE_WEBHOOK_SECRET` was set when the other Stripe secrets were originally set to live mode (likely, since they were all drifted together), then the webhook secret is also live mode and a full test-mode purchase would fail at the signature-verification step in `handleStripeWebhook` at `stripe.ts:622`. Fixing this is a 5-minute rotation job once the test-mode webhook endpoint is confirmed to exist or created in the Stripe dashboard.

2. **Two tenant records were created in production KV (`TENANT_DATA`) and D1 (`businesses`) during this session's verifications**, keyed by `moreland-property-group.hosted.advocatemcp.com` and `test-phase-b-v2-pro.hosted.advocatemcp.com`. Both are in `pending_payment` status and have `skipDns: true`. Neither corresponds to a real customer. **These should be cleaned up as part of tomorrow's session preamble using the same cleanup playbook from earlier tonight's sessions** — delete TENANT_DATA KV entries, delete BUSINESS_MAP KV entries (if any were written for the synthesized `.hosted.advocatemcp.com` domains — check), and clean up the `businesses` D1 rows if they were inserted by `registerBusinessInD1` at `stripe.ts:569-606`. Low priority but should happen before Phase C to keep the production tenant list clean.

3. **1Password cleanup for rollback values**: Cameron committed to a post-Phase-B cleanup adding the pre-rotation live-mode price IDs to 1Password with labels `"AdvocateMCP — STRIPE_PRICE_ID_BASE — live mode (rollback Apr 10 2026)"` and `"AdvocateMCP — STRIPE_PRICE_ID_PRO — live mode (rollback Apr 10 2026)"`. This migrates the rollback values from a parallel Claude advisory chat thread into the canonical password-manager location. Should happen within a day or two while the chat thread is still accessible.

4. **The `stripe_key_probe` diagnostic at `worker/src/routes/stripe.ts:398-407` remains in place** and is explicitly NOT being removed in this session per Phase B scope. Its removal is a separate follow-up commit after the fix holds for at least 24-48 hours without regression. The inline comment on the probe already says "Remove in a follow-up deploy once the test-mode flow is verified end-to-end" — that follow-up deploy is scheduled for a future session.

5. **Live mode is NOT ready for real customers.** This session deliberately targeted test mode. To accept real paying customers, all four Stripe secrets (`STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID_BASE`, `STRIPE_PRICE_ID_PRO`, `STRIPE_WEBHOOK_SECRET`) must be simultaneously rotated to their live-mode equivalents, with the same propose-then-rotate discipline. Cameron's plan is to verify live mode in a separate sub-task with a real $0.50 test transaction that he'll issue manually and refund from the Stripe dashboard. That work requires direct Stripe dashboard access and did not happen tonight. **Explicit reminder: live mode verification is NOT part of Phase B exit criteria and should not be attempted in a non-focused session.**

6. **`handlePublicOnboard` has a known `customer_email` validation quirk not addressed by Phase B**: Cameron used `asdf@gmail.com` as the submitted email, which passed the worker's regex at `stripe.ts:376` but is an obviously-fake value. This is not a Phase B concern — it's a separate input-validation tightening opportunity that predates today's rotation work. Flagged only because it was visible in the `customer_email` field of both successful Stripe Checkout Sessions and a real customer running through the flow with a legitimate email would behave identically.

---

## Followups for future sessions

Beyond the residual concerns above, the natural continuation of Phase B work is Phase C per the rearchitecture plan (`docs/rearchitecture-plan-2026-04-10.md` Section 8 Phase C — backend and auth foundation). Phase C is **out of scope for this session** per the explicit instructions at the end of Phase B's prompt and will be the subject of a dedicated session tomorrow.

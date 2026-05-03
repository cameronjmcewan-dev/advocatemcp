# Activation Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist signup-form passwords; activation step verifies email + auto-logs in. Customer never sees a duplicate credential ask.

**Architecture:** Add `email_verified` column to D1 `users` table (default 0). Signup-form POST creates user row + session before Stripe redirect. Activation token-click flips `email_verified=1` and mints a fresh session (handles cross-device). Dashboard middleware gates on `email_verified=1`, returning a 403 + splash for unverified users.

**Tech Stack:** Cloudflare Worker (TypeScript), D1 (`advocatemcp-auth`), Cloudflare Pages site (vanilla JS in `site/`), vitest for unit tests, `wrangler` CLI.

**Reference spec:** [`docs/superpowers/specs/2026-05-02-activation-flow-design.md`](../specs/2026-05-02-activation-flow-design.md)

---

## Task 0: Create isolated worktree off main

The user's main working tree has uncommitted changes on `worker/src/routes/{activate.ts,portal.ts}`, `site/{activate.html,js/dashboard-activate.js}` and ~25 other files. Working in a fresh worktree off `origin/main` keeps that WIP untouched.

**Files:**
- Create: `/Users/cameronmcewan/Desktop/advocate-activation-flow/` (new worktree)

- [ ] **Step 1: Verify clean state of origin/main**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git fetch origin main
git log origin/main --oneline -3
```

Expected: shows `0d80d25 docs(specs): activation flow ...` as latest.

- [ ] **Step 2: Create worktree on a new branch**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git worktree add /Users/cameronmcewan/Desktop/advocate-activation-flow -b feat/activation-flow origin/main
cd /Users/cameronmcewan/Desktop/advocate-activation-flow
git status
```

Expected: clean tree on `feat/activation-flow`, HEAD at `0d80d25`.

- [ ] **Step 3: Verify wrangler is linked to the right worker dir**

```bash
cd /Users/cameronmcewan/Desktop/advocate-activation-flow/worker
cat wrangler.toml | head -30
```

Expected: shows `name = "advocatemcp-worker"` and `database_name = "advocatemcp-auth"`.

---

## Task 1: D1 migration — add `email_verified` column + backfill paying users

**Files:**
- Create: `worker/migrations/0014_users_email_verified.sql`

- [ ] **Step 1: Write the migration file**

```bash
cat > /Users/cameronmcewan/Desktop/advocate-activation-flow/worker/migrations/0014_users_email_verified.sql <<'SQL'
-- Migration 0014: users.email_verified column.
--
-- Activation flow refactor (May 2 2026 — see
-- docs/superpowers/specs/2026-05-02-activation-flow-design.md):
-- new signups land at email_verified=0 and clear the bit by clicking
-- the activation email. Dashboard middleware refuses to serve until
-- email_verified=1.
--
-- Backfill marks every currently-active paying customer (joined via
-- user_business_access → businesses with a non-null stripe_subscription_id)
-- as already verified, so existing logins don't break. New unpaid /
-- pre-fix records stay at 0 — they hit the splash on next dashboard
-- load and click the activation email to get unstuck.

ALTER TABLE users
  ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;

UPDATE users
SET email_verified = 1
WHERE id IN (
  SELECT DISTINCT uba.user_id
  FROM user_business_access uba
  JOIN businesses b ON b.id = uba.business_id
  WHERE b.stripe_subscription_id IS NOT NULL
);
SQL
```

- [ ] **Step 2: Apply migration to local D1 (dev)**

```bash
cd /Users/cameronmcewan/Desktop/advocate-activation-flow/worker
npx wrangler d1 migrations apply advocatemcp-auth --local
```

Expected output: `🌀 Mapping SQL input into an array of statements`, then `🚣 Executed 2 commands ... ✅ 0014_users_email_verified.sql`.

- [ ] **Step 3: Verify column exists locally**

```bash
npx wrangler d1 execute advocatemcp-auth --local \
  --command "SELECT sql FROM sqlite_master WHERE type='table' AND name='users';"
```

Expected: output contains `email_verified INTEGER NOT NULL DEFAULT 0`.

- [ ] **Step 4: Apply migration to REMOTE D1 (production)**

This is the safe step — D1 migrations run via this explicit command, NOT at worker boot, so a bad migration cannot crash production traffic.

```bash
npx wrangler d1 migrations apply advocatemcp-auth --remote
```

Expected: same success message. If it fails, prod is unaffected — fix the SQL and re-run. Do NOT proceed to any later task until this succeeds.

- [ ] **Step 5: Verify backfill ran on remote**

```bash
npx wrangler d1 execute advocatemcp-auth --remote \
  --command "SELECT COUNT(*) AS verified, (SELECT COUNT(*) FROM users) AS total FROM users WHERE email_verified=1;"
```

Expected: `verified` should equal the number of users currently linked to a paid business (workman-copy-co's owner, etc.). `total` is everyone.

- [ ] **Step 6: Commit the migration file**

```bash
cd /Users/cameronmcewan/Desktop/advocate-activation-flow
git add worker/migrations/0014_users_email_verified.sql
git commit -m "$(cat <<'COMMIT'
feat(d1): migration 0014 — users.email_verified column

Adds the column for the activation-flow refactor. Backfill marks every
currently-paying customer as verified so existing logins keep working;
new signups land at 0 and clear the bit via the activation email click.

Applied to local + remote D1 before code that reads the column ships.
COMMIT
)"
```

---

## Task 2: Frontend — send password from signup form

**Files:**
- Modify: `site/onboarding.html` around line 2017 (read password) and line 2155 (add to payload)

- [ ] **Step 1: Read current `buildOnboardPayload` to confirm the patch site**

```bash
sed -n '2014,2020p;2153,2167p' /Users/cameronmcewan/Desktop/advocate-activation-flow/site/onboarding.html
```

Expected: see `const acct_email = v('acct-email').trim().toLowerCase();` near line 2017 and the `const outer = { slug, name, email: acct_email, plan, profile };` block near 2155.

- [ ] **Step 2: Add a password read after `acct_email`**

In `site/onboarding.html`, find this line (around line 2017):

```js
  const acct_email = v('acct-email').trim().toLowerCase();
```

Add immediately after it:

```js
  const acct_password = v('acct-password');
```

(No trim — passwords can legitimately contain trailing/leading spaces; the user's input is canonical.)

- [ ] **Step 3: Add `password` to the outer payload**

Find this block (around lines 2155-2161):

```js
  const outer = {
    slug: slugify(name),
    name,
    email: acct_email,
    plan: state.plan,
    profile,
  };
```

Replace with:

```js
  const outer = {
    slug: slugify(name),
    name,
    email: acct_email,
    password: acct_password,
    plan: state.plan,
    profile,
  };
```

- [ ] **Step 4: Verify the diff is exactly 2 lines added**

```bash
cd /Users/cameronmcewan/Desktop/advocate-activation-flow
git diff --stat site/onboarding.html
git diff site/onboarding.html | grep '^+' | grep -v '^+++'
```

Expected: 2 added lines (`+ const acct_password = v('acct-password');` and `+ password: acct_password,`).

- [ ] **Step 5: Commit**

```bash
git add site/onboarding.html
git commit -m "feat(onboarding): include password in /api/onboard/public payload

Was discarded client-side — now sent so the worker can hash + persist
it at signup time, eliminating the duplicate credential ask at
activation."
```

---

## Task 3: Worker — `handlePublicOnboard` hashes password, creates user, mints session (TDD)

**Files:**
- Modify: `worker/src/routes/stripe.ts` (`handlePublicOnboard` at line 539)
- Test: `worker/src/routes/stripe.publicOnboard.test.ts` (new)

- [ ] **Step 1: Locate the existing test file convention**

```bash
ls /Users/cameronmcewan/Desktop/advocate-activation-flow/worker/src/routes/*.test.ts | head -5
```

Expected: confirms `.test.ts` co-located with route files.

- [ ] **Step 2: Write the failing test**

Create `worker/src/routes/stripe.publicOnboard.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { handlePublicOnboard } from "./stripe";

// Minimal env mock — only what handlePublicOnboard touches for the
// password-handling path. Stripe creation, KV writes, etc. are stubbed
// to no-op success responses.
function mockEnv() {
  const users = new Map<string, { id: string; email: string; password_hash: string; salt: string; email_verified: number }>();
  const sessions = new Map<string, { id: string; user_id: string; token_hash: string }>();

  const DB = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (/^INSERT INTO users/i.test(sql)) {
                const [id, email, password_hash, salt] = args as string[];
                users.set(id, { id, email, password_hash, salt, email_verified: 0 });
              }
              if (/^INSERT INTO sessions/i.test(sql)) {
                const [id, user_id, token_hash] = args as string[];
                sessions.set(id, { id, user_id, token_hash });
              }
              return { success: true, meta: { changes: 1 } };
            },
            async first<T>() {
              if (/SELECT .* FROM users WHERE email/i.test(sql)) {
                const email = args[0] as string;
                for (const u of users.values()) if (u.email === email) return u as T;
                return null;
              }
              return null;
            },
            async all() {
              return { results: [], success: true };
            },
          };
        },
      };
    },
  };

  const KV = { put: vi.fn().mockResolvedValue(undefined), get: vi.fn().mockResolvedValue(null) };

  return {
    env: {
      DB: DB as unknown as D1Database,
      TENANT_DATA: KV as unknown as KVNamespace,
      BUSINESS_MAP: KV as unknown as KVNamespace,
      ACCESS_TOKEN_SIGNING_KEY: "x".repeat(64),
      STRIPE_SECRET_KEY: "sk_test_dummy",
      STRIPE_PRICE_ID_BASE: "price_base",
      STRIPE_PRICE_ID_PRO: "price_pro",
    } as unknown as Parameters<typeof handlePublicOnboard>[1],
    users,
    sessions,
  };
}

function jsonReq(body: unknown): Request {
  return new Request("https://customers.advocatemcp.com/api/onboard/public", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handlePublicOnboard — password handling", () => {
  beforeEach(() => {
    // Stub Stripe checkout creation (the public onboard ends with a redirect URL)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ id: "cs_test_123", url: "https://checkout.stripe.com/cs_test_123" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));
  });

  it("rejects payload missing password with 400 + validation_error", async () => {
    const { env } = mockEnv();
    const req = jsonReq({
      slug: "smoke-test-001",
      name: "Smoke Test",
      email: "smoke@example.com",
      plan: "base",
      // password omitted
    });
    const res = await handlePublicOnboard(req, env);
    expect(res.status).toBe(400);
    const body = await res.json() as { error_code: string };
    expect(body.error_code).toBe("validation_error");
  });

  it("rejects password shorter than 8 chars", async () => {
    const { env } = mockEnv();
    const req = jsonReq({
      slug: "smoke-test-002",
      name: "Smoke Test",
      email: "smoke2@example.com",
      password: "short",
      plan: "base",
    });
    const res = await handlePublicOnboard(req, env);
    expect(res.status).toBe(400);
  });

  it("hashes the password and inserts a users row with email_verified=0", async () => {
    const { env, users } = mockEnv();
    const req = jsonReq({
      slug: "smoke-test-003",
      name: "Smoke Test",
      email: "smoke3@example.com",
      password: "correct-horse-battery",
      plan: "base",
    });
    await handlePublicOnboard(req, env);
    const inserted = Array.from(users.values()).find(u => u.email === "smoke3@example.com");
    expect(inserted).toBeDefined();
    expect(inserted!.email_verified).toBe(0);
    expect(inserted!.password_hash.length).toBeGreaterThan(20);
    expect(inserted!.password_hash).not.toBe("correct-horse-battery"); // not plaintext
  });

  it("sets the amcp_refresh cookie on the response", async () => {
    const { env } = mockEnv();
    const req = jsonReq({
      slug: "smoke-test-004",
      name: "Smoke Test",
      email: "smoke4@example.com",
      password: "correct-horse-battery",
      plan: "base",
    });
    const res = await handlePublicOnboard(req, env);
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toMatch(/amcp_refresh=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
  });
});
```

- [ ] **Step 3: Run the test — it should fail**

```bash
cd /Users/cameronmcewan/Desktop/advocate-activation-flow/worker
npx vitest run src/routes/stripe.publicOnboard.test.ts
```

Expected: 4 failing tests because `handlePublicOnboard` does not yet read `password`, hash it, insert a user, or set the cookie.

- [ ] **Step 4: Add the imports + helpers in `stripe.ts`**

At the top of `worker/src/routes/stripe.ts`, near the existing imports, add (only if not already present):

```ts
import { generateSalt, hashPassword } from "../auth";
import { generateSessionToken, hashToken } from "../lib/access-token";
import { createUser, grantAccess, getUserByEmail } from "../portalDb";
import { refreshCookieHeader } from "./authApi";
```

(Use whichever import paths the codebase already uses — `worker/src/routes/activate.ts` lines 50-60 are the canonical reference.)

- [ ] **Step 5: Add the password-handling block to `handlePublicOnboard`**

In `handlePublicOnboard` (currently `worker/src/routes/stripe.ts:539`), find the existing field-extraction block:

```ts
  const email = (body.email as string ?? "").trim().toLowerCase();
  const plan = ((body.plan as string ?? "base").toLowerCase()) as "base" | "pro";
  const referralUrl = (body.referral_url as string ?? "").trim();
```

Add immediately after:

```ts
  const password = typeof body.password === "string" ? body.password : "";
```

In the existing `errors` validation block, add password validation right after the `email` check:

```ts
  if (!password || password.length < 8) {
    errors.push("password (must be at least 8 characters)");
  }
```

- [ ] **Step 6: After the `tenant` record is built (around line 655) but BEFORE the Stripe checkout creation, create the user + session**

Insert this block just before the existing Stripe checkout call (find the existing `await stripeApi(...)` or similar — look for where the response with `checkout_url` is built):

```ts
  // ── Create user + mint session BEFORE Stripe redirect ─────────────
  // The customer is logged in immediately so the post-checkout return
  // page (and the eventual activation email click) can rely on a
  // pre-existing session. email_verified stays at 0 until they click
  // the activation email; dashboard middleware gates on that bit.
  const existingUser = await getUserByEmail(env.DB, email);
  if (existingUser) {
    return withCors(
      jsonErr(409, "email_taken", "An account with this email already exists. Log in instead."),
      request,
    );
  }
  const salt = generateSalt();
  const passwordHash = await hashPassword(password, salt);
  const user = await createUser(env.DB, email, passwordHash, salt, name, "client");

  // Mint a session — same shape as handleActivateHosted (see
  // worker/src/routes/activate.ts:996-1007 for the canonical pattern).
  const refreshRawToken = generateSessionToken();
  const refreshTokenHash = await hashToken(refreshRawToken);
  const sessionId = crypto.randomUUID().replace(/-/g, "");
  const nowIso = new Date().toISOString();
  const expiresIso = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB
    .prepare(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(sessionId, user.id, refreshTokenHash, expiresIso, nowIso, nowIso)
    .run();
```

- [ ] **Step 7: Add the Set-Cookie header to the success response**

Find the existing success response in `handlePublicOnboard` — the one that returns `{ checkout_url, ... }`. Wrap its `Response` constructor's `headers` to include the cookie:

```ts
  const successHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Set-Cookie": refreshCookieHeader(refreshRawToken),
  };
  return withCors(
    new Response(JSON.stringify({ /* existing body */ }), {
      status: 200,
      headers: successHeaders,
    }),
    request,
    { credentials: true },
  );
```

(If the existing code uses `jsonOk(...)` instead of `new Response(...)`, copy the body shape from `jsonOk` into the inline `Response` so we can attach the cookie header. The `withCors(..., { credentials: true })` flag is required for the cookie to be set cross-origin.)

- [ ] **Step 8: Re-run the test — should now pass**

```bash
cd /Users/cameronmcewan/Desktop/advocate-activation-flow/worker
npx vitest run src/routes/stripe.publicOnboard.test.ts
```

Expected: 4 passing tests.

- [ ] **Step 9: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 10: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate-activation-flow
git add worker/src/routes/stripe.ts worker/src/routes/stripe.publicOnboard.test.ts
git commit -m "$(cat <<'COMMIT'
feat(onboard): hash password + mint session in handlePublicOnboard

The signup form now ships the password to the worker, where it's hashed
(PBKDF2 via worker/src/auth.ts), persisted on a fresh users row, and
followed by a session-cookie set. Customer is logged in before the
Stripe redirect, so post-checkout pages can greet by name.

email_verified defaults to 0 — dashboard middleware (added in a later
commit) gates on the activation-email click before serving real data.
COMMIT
)"
```

---

## Task 4: Worker — `handleActivateHosted` branches on existing user (TDD)

When a user already has a `password_hash` on file, the activation token's only job is to flip `email_verified=1` + mint a fresh session. The legacy "set your password" branch stays for customers who signed up BEFORE this fix landed (they have no users row yet).

**Files:**
- Modify: `worker/src/routes/activate.ts` (`handleActivateHosted` at line 869)
- Test: `worker/src/routes/activate.hosted.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `worker/src/routes/activate.hosted.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleActivateHosted } from "./activate";

// Reuse the same mockEnv harness as stripe.publicOnboard.test.ts, but
// with a `tenants` map so getTenant() resolves to a hosted-tenant
// record (skipDns: true) and a `getBusinessBySlug` stub.
//
// Helper inline here to keep the test self-contained — feel free to
// extract to a shared test util if more activation tests follow.
function mockEnvWithUser(opts: { hasPassword: boolean }) {
  const userId = "user_existing_001";
  const users = new Map<string, { id: string; email: string; password_hash: string; salt: string; email_verified: number; full_name: string; role: string }>();
  if (opts.hasPassword) {
    users.set(userId, {
      id: userId,
      email: "existing@example.com",
      password_hash: "stored_hash",
      salt: "stored_salt",
      email_verified: 0,
      full_name: "Existing User",
      role: "client",
    });
  }

  const businesses = new Map<string, { id: string; slug: string }>();
  businesses.set("biz_001", { id: "biz_001", slug: "smoke-test-001" });

  const sessions = new Map<string, unknown>();
  const updates: { sql: string; args: unknown[] }[] = [];

  const DB = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              updates.push({ sql, args });
              if (/INSERT INTO sessions/i.test(sql)) {
                sessions.set(args[0] as string, { user_id: args[1], token_hash: args[2] });
              }
              return { success: true, meta: { changes: 1 } };
            },
            async first<T>() {
              if (/SELECT .* FROM users WHERE email/i.test(sql)) {
                const email = args[0] as string;
                for (const u of users.values()) if (u.email === email) return u as T;
                return null;
              }
              if (/SELECT .* FROM businesses WHERE slug/i.test(sql)) {
                for (const b of businesses.values()) if (b.slug === args[0]) return b as T;
                return null;
              }
              return null;
            },
          };
        },
      };
    },
  };

  return {
    env: {
      DB: DB as unknown as D1Database,
      TENANT_DATA: { get: vi.fn().mockResolvedValue(JSON.stringify({
        slug: "smoke-test-001",
        name: "Smoke Test",
        email: "existing@example.com",
        skipDns: true,
      })) } as unknown as KVNamespace,
      ACTIVATION_SIGNING_KEY: "y".repeat(64),
      ACCESS_TOKEN_SIGNING_KEY: "x".repeat(64),
      RESEND_API_KEY: "re_dummy",
    },
    users,
    sessions,
    updates,
    userId,
  };
}

// Build a request with a valid activation token for slug=smoke-test-001.
async function tokenReq(env: unknown, body: Record<string, unknown> = {}): Promise<Request> {
  // Inline mint a token with the same signing key the env uses.
  // Use the same helper handleActivateHosted does — see
  // worker/src/lib/activation-token.ts for signActivationToken.
  const { signActivationToken } = await import("../lib/activation-token");
  const token = await signActivationToken(
    { slug: "smoke-test-001", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 },
    (env as { ACTIVATION_SIGNING_KEY: string }).ACTIVATION_SIGNING_KEY,
  );
  return new Request("https://customers.advocatemcp.com/api/activate/hosted", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Activation-Token": token },
    body: JSON.stringify(body),
  });
}

describe("handleActivateHosted — existing-user branch", () => {
  it("when user has password_hash, succeeds with empty body — sets email_verified=1, mints session", async () => {
    const { env, updates } = mockEnvWithUser({ hasPassword: true });
    const req = await tokenReq(env, {}); // no password field
    const res = await handleActivateHosted(req, env as never);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(updates.some(u => /UPDATE users SET email_verified\s*=\s*1/i.test(u.sql))).toBe(true);
    expect(res.headers.get("Set-Cookie") ?? "").toMatch(/amcp_refresh=/);
  });

  it("when user has password_hash, ignores any password in the body (does not overwrite hash)", async () => {
    const { env, updates } = mockEnvWithUser({ hasPassword: true });
    const req = await tokenReq(env, { password: "different-password" });
    await handleActivateHosted(req, env as never);
    expect(updates.some(u => /UPDATE users SET password_hash/i.test(u.sql))).toBe(false);
  });

  it("when no users row exists yet (legacy path), still requires + accepts a password ≥8 chars", async () => {
    const { env, updates } = mockEnvWithUser({ hasPassword: false });
    const req = await tokenReq(env, { password: "correct-horse-battery" });
    const res = await handleActivateHosted(req, env as never);
    expect(res.status).toBe(200);
    expect(updates.some(u => /INSERT INTO users/i.test(u.sql))).toBe(true);
  });

  it("legacy path rejects missing password with 400", async () => {
    const { env } = mockEnvWithUser({ hasPassword: false });
    const req = await tokenReq(env, {}); // no password
    const res = await handleActivateHosted(req, env as never);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test — should fail**

```bash
cd /Users/cameronmcewan/Desktop/advocate-activation-flow/worker
npx vitest run src/routes/activate.hosted.test.ts
```

Expected: at least the first 2 tests fail (the legacy path may pass since it's the existing behavior).

- [ ] **Step 3: Modify `handleActivateHosted` to branch**

In `worker/src/routes/activate.ts`, find the password-validation block (around lines 961-975):

```ts
  // ── Validate password ──────────────────────────────────────────────────
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 8) {
    return withCors(
      new Response(
        JSON.stringify({
          ok: false,
          error_code: "password_too_short",
          customer_message: "Password must be at least 8 characters.",
        }, null, 2),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
      request,
    );
  }
```

Replace it with:

```ts
  // ── Branch on existing user ────────────────────────────────────────────
  // Post-May-2-2026 signups: handlePublicOnboard already created the
  // users row + hashed the password. Activation's only job here is to
  // flip email_verified=1 and mint a fresh session (cross-device).
  // Legacy pre-fix signups: no users row yet — fall through to the
  // password-set path.
  const email = tenant.email.toLowerCase().trim();
  const existingUser = await getUserByEmail(env.DB, email);

  let user: Awaited<ReturnType<typeof getUserByEmail>>;
  if (existingUser && existingUser.password_hash) {
    // Fast path: just verify-the-email + mint session.
    await env.DB
      .prepare("UPDATE users SET email_verified = 1 WHERE id = ?")
      .bind(existingUser.id)
      .run();
    user = { ...existingUser, email_verified: 1 };
  } else {
    // Legacy path: original password-set behavior.
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < 8) {
      return withCors(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: "password_too_short",
            customer_message: "Password must be at least 8 characters.",
          }, null, 2),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
        request,
      );
    }
    const salt = generateSalt();
    const passwordHash = await hashPassword(password, salt);
    if (existingUser) {
      await updateUserPassword(env.DB, existingUser.id, passwordHash, salt);
      user = { ...existingUser, password_hash: passwordHash, salt };
    } else {
      user = await createUser(env.DB, email, passwordHash, salt, tenant.name, "client");
    }
    // New legacy users still need email_verified = 1 — they're
    // proving email ownership by clicking through.
    await env.DB
      .prepare("UPDATE users SET email_verified = 1 WHERE id = ?")
      .bind(user.id)
      .run();
  }

  // ── Link user to business (idempotent via INSERT OR IGNORE) ────────────
  await grantAccess(env.DB, user.id, biz.id);
```

(Then DELETE the existing block from `// ── Create or update user ──` through `await grantAccess(...);` since the new block subsumes it. Visually verify there's no leftover dead code.)

- [ ] **Step 4: Re-run the test — should pass**

```bash
cd /Users/cameronmcewan/Desktop/advocate-activation-flow/worker
npx vitest run src/routes/activate.hosted.test.ts
```

Expected: 4 passing tests.

- [ ] **Step 5: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate-activation-flow
git add worker/src/routes/activate.ts worker/src/routes/activate.hosted.test.ts
git commit -m "$(cat <<'COMMIT'
feat(activate): hosted-tenant branch — skip password ask if user exists

Post-May-2-2026 signups already have a users row + hashed password (via
handlePublicOnboard). Activation in that case is a one-step "verify
email + mint fresh session" — the customer never re-types their
password. Legacy pre-fix signups still hit the password-set path so
they're not stranded mid-flow.

Cross-device behavior preserved: the activation click always mints a
new session in whatever browser opened the email link.
COMMIT
)"
```

---

## Task 5: Worker — `renderHostedPage` shows confirm button when user has password

**Files:**
- Modify: `worker/src/routes/activatePage.ts` (`renderHostedPage` at line 154 + `handleActivatePage` at line 80)

- [ ] **Step 1: Add the user-existence check to `handleActivatePage`**

In `worker/src/routes/activatePage.ts`, find the block where `tenant` is loaded (around lines 95-106):

```ts
  if (hasToken) {
    const slug = extractSlugFromToken(tokenParam!);
    if (slug) {
      const tenantDomain = `${slug}.hosted.advocatemcp.com`;
      const tenant = await getTenant(env, tenantDomain);
      if (tenant && tenant.skipDns === true) {
        isHosted = true;
        hostedUrl = `https://${tenantDomain}`;
        tenantEmail = tenant.email ?? "";
      }
    }
  }
```

Add a `hasPassword` resolution after `tenantEmail` is set:

```ts
  let userHasPassword = false;
  if (hasToken && isHosted && tenantEmail) {
    const { getUserByEmail } = await import("../portalDb");
    const existingUser = await getUserByEmail(env.DB, tenantEmail.toLowerCase().trim());
    userHasPassword = !!(existingUser && existingUser.password_hash);
  }
```

- [ ] **Step 2: Pass `userHasPassword` into `renderHostedPage`**

Find the `renderHostedPage` call at line 132:

```ts
  return new Response(
    renderHostedPage(escapedToken, escapeHtml(hostedUrl), escapeHtml(tenantEmail)),
```

Change to:

```ts
  return new Response(
    renderHostedPage(escapedToken, escapeHtml(hostedUrl), escapeHtml(tenantEmail), userHasPassword),
```

- [ ] **Step 3: Update `renderHostedPage` signature + branch the State H1 markup**

In `renderHostedPage`, change the signature:

```ts
function renderHostedPage(escapedToken: string, hostedUrl: string, email: string, userHasPassword: boolean): string {
```

Then find the State H1 section (lines 198-214 in the original):

```html
<!-- State H1 — Password form -->
<div class="state active" id="state-h1">
  <div class="tag">Account setup</div>
  <h1 class="h1">Set your password</h1>
  <p class="lede">Choose a password for your AdvocateMCP dashboard. You'll use this email and password to log in.</p>

  <div class="card">
    <label class="label" for="hosted-email">Email</label>
    <input class="input" type="email" id="hosted-email" value="${email}" readonly>
    <div class="hint">This is the email you signed up with. It can't be changed here.</div>

    <label class="label" for="hosted-password" style="margin-top:1rem">Password</label>
    <input class="input" type="password" id="hosted-password" placeholder="At least 8 characters" minlength="8" required autocomplete="new-password">

    <button type="button" class="btn" id="hosted-submit-btn">Set password and continue</button>
  </div>
</div>
```

Replace with a conditional render:

```html
<!-- State H1 — Account confirm (post-May-2-2026 signups) OR password setup (legacy) -->
${userHasPassword ? `
<div class="state active" id="state-h1">
  <div class="tag">Almost there</div>
  <h1 class="h1">Confirm your email and continue</h1>
  <p class="lede">We sent this link to <strong>${email}</strong> to confirm it's you. Click below to verify your email and head to your dashboard.</p>

  <div class="card">
    <button type="button" class="btn" id="hosted-submit-btn">Confirm and go to dashboard</button>
  </div>
</div>
` : `
<div class="state active" id="state-h1">
  <div class="tag">Account setup</div>
  <h1 class="h1">Set your password</h1>
  <p class="lede">Choose a password for your AdvocateMCP dashboard. You'll use this email and password to log in.</p>

  <div class="card">
    <label class="label" for="hosted-email">Email</label>
    <input class="input" type="email" id="hosted-email" value="${email}" readonly>
    <div class="hint">This is the email you signed up with. It can't be changed here.</div>

    <label class="label" for="hosted-password" style="margin-top:1rem">Password</label>
    <input class="input" type="password" id="hosted-password" placeholder="At least 8 characters" minlength="8" required autocomplete="new-password">

    <button type="button" class="btn" id="hosted-submit-btn">Set password and continue</button>
  </div>
</div>
`}
```

- [ ] **Step 4: Update the inline submit handler to handle no-password case**

In the same file, find the `<script>` block around line 270:

```js
  submitBtn.addEventListener("click", function(){
    clearError();
    var password = passwordInput.value || "";
    if (password.length < 8) {
      showError("Password must be at least 8 characters.");
      return;
    }
    // ...
    body: JSON.stringify({ password: password })
```

Replace the click handler body with:

```js
  submitBtn.addEventListener("click", function(){
    clearError();
    var password = passwordInput ? (passwordInput.value || "") : "";
    // If the password input isn't on the page (post-May-2 confirm-only
    // flow), submit with an empty body — the worker's existing-user
    // branch ignores password and just flips email_verified.
    if (passwordInput && password.length < 8) {
      showError("Password must be at least 8 characters.");
      return;
    }

    submitBtn.disabled = true;
    showState("state-h2");

    fetch("/api/activate/hosted", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Activation-Token": token
      },
      body: JSON.stringify(passwordInput ? { password: password } : {})
    })
```

(The rest of the `.then(...).catch(...)` chain stays as-is.)

Also wrap the `passwordInput` lookup defensively:

```js
  var passwordInput = document.getElementById("hosted-password");
```

This stays — it returns null when the field isn't rendered, and the click handler now tolerates null.

- [ ] **Step 5: Run typecheck**

```bash
cd /Users/cameronmcewan/Desktop/advocate-activation-flow/worker
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate-activation-flow
git add worker/src/routes/activatePage.ts
git commit -m "$(cat <<'COMMIT'
feat(activatePage): one-button confirm flow when user already has password

Renders 'Confirm and go to dashboard' (no password input) for hosted
tenants whose users row already has a password_hash. Pre-fix legacy
customers still see the original 'Set your password' form.

Inline JS branches on whether the password input rendered — null-safe.
COMMIT
)"
```

---

## Task 6: Worker — `getSessionFromRequest` exposes `email_verified` (TDD)

**Files:**
- Modify: `worker/src/routes/authApi.ts` (`getSessionFromRequest` at line 148, `AuthContext` type at line 105)
- Modify: `worker/src/portalDb.ts` (`getUserById` query — needs to return the new column)
- Test: `worker/src/routes/authApi.emailVerified.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `worker/src/routes/authApi.emailVerified.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { getSessionFromRequest } from "./authApi";

function mockEnv(opts: { email_verified: 0 | 1 }) {
  const DB = {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first() {
              if (/SELECT .* FROM sessions/i.test(sql)) {
                return { id: "s1", user_id: "u1", token_hash: "h", expires_at: new Date(Date.now() + 3600_000).toISOString() };
              }
              if (/SELECT .* FROM users/i.test(sql)) {
                return {
                  id: "u1",
                  email: "test@example.com",
                  password_hash: "h",
                  salt: "s",
                  full_name: "Test",
                  role: "client",
                  email_verified: opts.email_verified,
                };
              }
              return null;
            },
            async run() { return { success: true }; },
          };
        },
      };
    },
  };
  return { DB: DB as unknown as D1Database } as unknown as Parameters<typeof getSessionFromRequest>[1];
}

function reqWithCookie(): Request {
  return new Request("https://customers.advocatemcp.com/api/client/all-metrics", {
    headers: { Cookie: "amcp_refresh=raw_token_value" },
  });
}

describe("getSessionFromRequest — email_verified surfacing", () => {
  it("returns email_verified=1 in the AuthContext when the column is 1", async () => {
    const env = mockEnv({ email_verified: 1 });
    const ctx = await getSessionFromRequest(reqWithCookie(), env);
    expect(ctx).not.toBeNull();
    expect(ctx!.email_verified).toBe(1);
  });

  it("returns email_verified=0 when the column is 0", async () => {
    const env = mockEnv({ email_verified: 0 });
    const ctx = await getSessionFromRequest(reqWithCookie(), env);
    expect(ctx).not.toBeNull();
    expect(ctx!.email_verified).toBe(0);
  });
});
```

- [ ] **Step 2: Run test — should fail**

```bash
cd /Users/cameronmcewan/Desktop/advocate-activation-flow/worker
npx vitest run src/routes/authApi.emailVerified.test.ts
```

Expected: 2 failing tests because `AuthContext` doesn't have `email_verified` yet.

- [ ] **Step 3: Add `email_verified` to the `User` type in `portalDb.ts`**

Find the `User` type definition (search for `export type User` or `export interface User`):

```bash
grep -n "export.*User\b" worker/src/portalDb.ts | head -5
```

Add the field to the type:

```ts
export interface User {
  id: string;
  email: string;
  password_hash: string;
  salt: string;
  full_name: string;
  role: string;
  created_at: string;
  email_verified: number;  // 0 or 1
}
```

(Match the existing field style — comma vs semicolon, etc.)

Then update the `SELECT` columns in `getUserByEmail` and `getUserById` to include `email_verified`:

```ts
const COLS = "id, email, password_hash, salt, full_name, role, created_at, email_verified";
```

(Or wherever the columns are listed today — replace `*` with explicit columns if `*` is used.)

- [ ] **Step 4: Add `email_verified` to `AuthContext` in `authApi.ts`**

Find `AuthContext` (around line 108):

```ts
export interface AuthContext {
  user_id: string;
  email: string;
  full_name: string;
  role: string;
  tenant_id: string | null;
  // ...existing fields
}
```

Add:

```ts
  email_verified: number;
```

In `getSessionFromRequest`, find where the context object is built (around lines 180-210). Add `email_verified: user.email_verified` to the returned context.

- [ ] **Step 5: Re-run test — should pass**

```bash
npx vitest run src/routes/authApi.emailVerified.test.ts
```

Expected: 2 passing tests.

- [ ] **Step 6: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: clean. If callers of `AuthContext` complain about a missing field somewhere, add `email_verified: ctx.email_verified` to the relevant construction site.

- [ ] **Step 7: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate-activation-flow
git add worker/src/routes/authApi.ts worker/src/portalDb.ts worker/src/routes/authApi.emailVerified.test.ts
git commit -m "feat(auth): surface email_verified in AuthContext

Required for the dashboard middleware gate (next commit). Backfill
ensured every existing paying-customer user has email_verified=1, so
this is non-breaking."
```

---

## Task 7: Worker — gate dashboard + `/api/client/*` on `email_verified=1`

**Files:**
- Modify: `worker/src/routes/portal.ts` — the dashboard route + `/api/client/*` handlers
- Test: `worker/src/routes/portal.emailUnverifiedGate.test.ts` (new)

- [ ] **Step 1: Identify the gate point**

Most `/api/client/*` and dashboard handlers in `portal.ts` already call `getSessionFromRequest(...)` and bail if it returns null. The cleanest gate is a small helper that wraps that pattern:

```ts
async function requireVerifiedSession(
  request: Request,
  env: Env,
): Promise<{ ok: true; ctx: AuthContext } | { ok: false; resp: Response }> {
  const ctx = await getSessionFromRequest(request, env);
  if (!ctx) {
    return { ok: false, resp: jsonErr(401, "no_session") };
  }
  if (ctx.email_verified !== 1) {
    return {
      ok: false,
      resp: new Response(
        JSON.stringify({ ok: false, error_code: "email_unverified", customer_message: "Please confirm your email — check your inbox for the activation link." }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    };
  }
  return { ok: true, ctx };
}
```

Add this helper near the top of `worker/src/routes/portal.ts`, right after the existing imports.

- [ ] **Step 2: Write the failing test**

Create `worker/src/routes/portal.emailUnverifiedGate.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { handlePortalRouter } from "./portal";

function mockEnv(opts: { email_verified: 0 | 1 }) {
  const DB = {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first() {
              if (/sessions/i.test(sql)) {
                return { id: "s1", user_id: "u1", token_hash: "h", expires_at: new Date(Date.now() + 3600_000).toISOString() };
              }
              if (/users/i.test(sql)) {
                return {
                  id: "u1",
                  email: "test@example.com",
                  password_hash: "h",
                  salt: "s",
                  full_name: "T",
                  role: "client",
                  email_verified: opts.email_verified,
                };
              }
              return null;
            },
          };
        },
      };
    },
  };
  return { DB: DB as unknown as D1Database } as unknown as Parameters<typeof handlePortalRouter>[1];
}

describe("portal — email_verified gate", () => {
  it("returns 403 + email_unverified for unverified user hitting /api/client/all-metrics", async () => {
    const env = mockEnv({ email_verified: 0 });
    const req = new Request("https://customers.advocatemcp.com/api/client/all-metrics", {
      headers: { Cookie: "amcp_refresh=raw_token_value" },
    });
    const res = await handlePortalRouter(req, env);
    expect(res.status).toBe(403);
    const body = await res.json() as { error_code: string };
    expect(body.error_code).toBe("email_unverified");
  });

  it("passes through (200 or 4xx unrelated) when user is verified", async () => {
    const env = mockEnv({ email_verified: 1 });
    const req = new Request("https://customers.advocatemcp.com/api/client/all-metrics", {
      headers: { Cookie: "amcp_refresh=raw_token_value" },
    });
    const res = await handlePortalRouter(req, env);
    expect(res.status).not.toBe(403);
  });
});
```

- [ ] **Step 3: Run test — should fail**

```bash
npx vitest run src/routes/portal.emailUnverifiedGate.test.ts
```

Expected: at least the first test fails (currently 200 or 401, not 403).

- [ ] **Step 4: Apply `requireVerifiedSession` to dashboard + `/api/client/*` handlers**

For each route handler in `portal.ts` that currently begins with:

```ts
const ctx = await getSessionFromRequest(request, env);
if (!ctx) return jsonErr(401, "no_session");
```

Replace with:

```ts
const guard = await requireVerifiedSession(request, env);
if (!guard.ok) return guard.resp;
const ctx = guard.ctx;
```

Apply this to (find them via `grep -n "getSessionFromRequest" worker/src/routes/portal.ts`):
- The dashboard page handler
- All `/api/client/*` handlers
- Any handler where the user is consuming dashboard data

DO NOT apply to:
- `/auth/login`, `/auth/logout` (the user can't be expected to be verified before logging in)
- `/auth/team-accept` (separate magic-link flow)
- `/api/activate/*` (activation IS the way they get verified)
- Admin endpoints (admins are verified by definition; if they're not, treat as a separate ticket)

- [ ] **Step 5: Re-run test — should pass**

```bash
npx vitest run src/routes/portal.emailUnverifiedGate.test.ts
```

Expected: 2 passing tests.

- [ ] **Step 6: Run full test suite**

```bash
cd /Users/cameronmcewan/Desktop/advocate-activation-flow/worker
npx vitest run
```

Expected: all tests pass. If any pre-existing test regresses because it built a mock user without `email_verified`, update those mocks to include `email_verified: 1`.

- [ ] **Step 7: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate-activation-flow
git add worker/src/routes/portal.ts worker/src/routes/portal.emailUnverifiedGate.test.ts
git commit -m "$(cat <<'COMMIT'
feat(portal): gate dashboard + /api/client/* on email_verified=1

requireVerifiedSession helper wraps getSessionFromRequest and returns
403 + error_code: 'email_unverified' for unverified users. Dashboard
client renders 'check your inbox' splash on that response.

Auth, activation, and team-accept routes are not gated — the user
can't be expected to be verified before logging in or activating.
COMMIT
)"
```

---

## Task 8: Frontend — dashboard "check your inbox" splash

**Files:**
- Modify: `site/assets/dashboard-chrome.js` (the shell that gates dashboard rendering on auth)
- (Possibly) `site/dashboard.html` if there's an inline 403 handler

- [ ] **Step 1: Locate the existing 401/403 handling**

```bash
grep -n "status.*403\|email_unverified\|status.*401\|no_session\|/auth/login" /Users/cameronmcewan/Desktop/advocate-activation-flow/site/assets/dashboard-chrome.js | head -10
```

Confirm the existing pattern for handling auth failures. If the chrome already redirects on 401, add a parallel 403 branch.

- [ ] **Step 2: Add the 403/email_unverified handler**

In `site/assets/dashboard-chrome.js`, find the auth-fetch wrapper (likely `authedFetch` or `cachedFetch`). Add a 403 + `error_code: "email_unverified"` branch that renders the splash:

```js
async function authedFetch(url, opts) {
  const res = await fetch(url, { ...opts, credentials: 'include' });
  if (res.status === 403) {
    try {
      const body = await res.clone().json();
      if (body.error_code === 'email_unverified') {
        renderEmailUnverifiedSplash(body.customer_message || 'Please confirm your email.');
        // Return a synthetic forbidden response so callers don't crash
        return res;
      }
    } catch (_) { /* fall through */ }
  }
  return res;
}

function renderEmailUnverifiedSplash(message) {
  if (document.getElementById('email-unverified-splash')) return; // idempotent
  const splash = document.createElement('div');
  splash.id = 'email-unverified-splash';
  splash.style.cssText = 'position:fixed;inset:0;background:var(--paper);display:grid;place-items:center;z-index:9999;padding:24px';
  splash.innerHTML =
    '<div style="max-width:420px;text-align:center;font-family:var(--sans)">' +
      '<h1 style="font-family:var(--serif);font-weight:400;font-size:32px;margin-bottom:12px">Check your inbox</h1>' +
      '<p style="color:var(--ink-2);font-size:14.5px;line-height:1.6;margin-bottom:24px">' +
        (message || 'Click the link we sent to confirm your email and finish setting up your dashboard.') +
      '</p>' +
      '<button id="resend-activation-btn" class="btn btn-primary" style="padding:10px 20px">Resend email</button>' +
      '<p style="color:var(--muted);font-size:12px;margin-top:16px">Wrong email? <a href="mailto:max@advocate-mcp.com">Contact support</a></p>' +
    '</div>';
  document.body.appendChild(splash);
  const btn = splash.querySelector('#resend-activation-btn');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Sending...';
    // POST to the existing /admin/email/resend-activation endpoint if available,
    // otherwise show a generic "we'll handle it manually" message.
    try {
      const r = await fetch('/api/activate/resend', { method: 'POST', credentials: 'include' });
      btn.textContent = r.ok ? 'Sent — check your inbox' : 'Could not resend — email max@advocate-mcp.com';
    } catch (_) {
      btn.textContent = 'Could not resend — email max@advocate-mcp.com';
    }
  });
}
```

(If `/api/activate/resend` doesn't exist as a public endpoint, the user can manually trigger it via the existing operator backstop at `worker/src/routes/activate.ts:720` for now — file a follow-up to expose a self-serve resend.)

- [ ] **Step 3: Manual smoke check (no Worker test possible here — vanilla JS in static site)**

Skip — this gets exercised in the manual dry-run task.

- [ ] **Step 4: Commit**

```bash
cd /Users/cameronmcewan/Desktop/advocate-activation-flow
git add site/assets/dashboard-chrome.js
git commit -m "feat(dashboard): render 'check your inbox' splash on 403 email_unverified

Pairs with the worker-side requireVerifiedSession gate. Splash blocks
all dashboard interaction until the customer clicks the activation
link. Resend button POSTs to /api/activate/resend (or shows fallback
support contact if the endpoint isn't deployed yet)."
```

---

## Task 9: Deploy worker + push site, smoke-test against production

**Files:** none changed in this task — pure deploy + verification.

- [ ] **Step 1: Run the full worker test suite + typecheck one more time**

```bash
cd /Users/cameronmcewan/Desktop/advocate-activation-flow/worker
npx vitest run
npx tsc --noEmit
```

Expected: all green.

- [ ] **Step 2: Deploy the worker**

```bash
cd /Users/cameronmcewan/Desktop/advocate-activation-flow/worker
npx wrangler deploy
```

Expected: success message ending with `Deployed advocatemcp-worker triggers ... customers.advocatemcp.com/*`.

- [ ] **Step 3: Verify the worker is healthy post-deploy**

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" https://customers.advocatemcp.com/healthz
```

Expected: HTTP 200 (or 401, depending on whether /healthz needs auth — both indicate the worker is responding).

- [ ] **Step 4: Push the branch + merge to main**

```bash
cd /Users/cameronmcewan/Desktop/advocate-activation-flow
git push -u origin feat/activation-flow
gh pr create --title "feat: activation flow — capture password at signup, gate on email_verified" --body "$(cat <<'BODY'
## Summary
- D1 migration 0014: adds `users.email_verified` column + backfills paying customers
- Onboarding form ships password to /api/onboard/public
- `handlePublicOnboard` hashes password, creates user + session before Stripe redirect
- `handleActivateHosted` branches: existing user → flip email_verified=1 + mint session; legacy → password-set path
- Activation page renders one-button confirm when user has password
- Dashboard middleware returns 403 + `email_unverified` for unverified users; client renders splash

Spec: `docs/superpowers/specs/2026-05-02-activation-flow-design.md`
Plan: `docs/superpowers/plans/2026-05-02-activation-flow.md`

## Test plan
- [x] Unit: `handlePublicOnboard` rejects missing/short password, hashes correctly, sets cookie
- [x] Unit: `handleActivateHosted` existing-user path skips password ask
- [x] Unit: `handleActivateHosted` legacy path still requires password
- [x] Unit: `getSessionFromRequest` surfaces `email_verified`
- [x] Unit: portal returns 403 for unverified user
- [ ] Manual: full flow on a throwaway tenant (Task 10 of plan)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

(If you're not using PRs and prefer direct push to main, replace with `git checkout main && git merge feat/activation-flow && git push origin main` — but PR is recommended given the prod-down history.)

- [ ] **Step 5: Wait for Pages auto-deploy on main merge**

Pages auto-deploys from `main` per `docs/followups.md`. After merge, visit `https://advocatemcp.com/onboarding` and view-source on the page to confirm the new `password: acct_password` line is in the deployed bundle. May take 30-60s.

---

## Task 10: Manual cross-device dry run

**Files:** none. This is a hands-on verification step.

- [ ] **Step 1: Pick a throwaway slug**

Use `smoke-test-NN` where NN is the next unused number. Confirm not taken:

```bash
curl -s "https://advocate-production-2887.up.railway.app/analytics/smoke-test-99" \
  -H "Authorization: Bearer dummy" -o /dev/null -w "HTTP %{http_code}\n"
```

Expected: `HTTP 401` or `HTTP 404` — anything that's not 200.

- [ ] **Step 2: Walk the signup flow on browser A (laptop)**

1. Visit `https://advocatemcp.com/onboarding`
2. Fill all fields including a real-looking email you control (e.g. `you+smoke99@gmail.com`) and a real password
3. Submit → should redirect to Stripe
4. Use the Stripe test card `4242 4242 4242 4242` with any future expiry / CVV / ZIP
5. Complete checkout → should redirect to a return page

- [ ] **Step 3: Verify session cookie was set on browser A**

Open DevTools → Application → Cookies → `customers.advocatemcp.com`. Confirm `amcp_refresh` exists.

- [ ] **Step 4: Visit /dashboard.html on browser A**

Expected: "Check your inbox" splash appears (because email_verified is still 0).

- [ ] **Step 5: Open the activation email on browser B (phone or incognito)**

Click the activation link. Expected:
- Lands on the activation page
- Shows "Confirm and go to dashboard" (single button, NO password field)
- Click → redirected to /dashboard
- Already logged in, full dashboard renders

- [ ] **Step 6: Refresh dashboard on browser A**

The original session is still good. Refresh the splash page — it should re-poll, find email_verified is now 1, and render the dashboard.

- [ ] **Step 7: Cleanup the smoke-test tenant**

```bash
# D1
npx wrangler d1 execute advocatemcp-auth --remote --command \
  "SELECT id FROM businesses WHERE slug='smoke-test-99';"
# capture <BIZ_ID>, then:
npx wrangler d1 execute advocatemcp-auth --remote --command \
  "DELETE FROM user_business_access WHERE business_id='<BIZ_ID>';"
npx wrangler d1 execute advocatemcp-auth --remote --command \
  "DELETE FROM businesses WHERE id='<BIZ_ID>';"
# users row stays — your test email may still be useful
```

- [ ] **Step 8: Cleanup the worktree**

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
git worktree remove /Users/cameronmcewan/Desktop/advocate-activation-flow
```

(If the worktree had uncommitted changes when you tried to remove, `git worktree remove --force` — but verify nothing was lost first.)

---

## Self-review checklist

Before declaring this plan done:

- **Spec coverage:** every section of the spec maps to a task above:
  - Schema change → Task 1
  - Frontend signup → Task 2
  - Backend onboard → Task 3
  - Activation branching → Tasks 4 + 5
  - Email-verified middleware → Task 6
  - Dashboard splash → Tasks 7 + 8
  - Migration safety → Tasks 1 + 9 (D1 first, deploy second)
  - Testing → embedded TDD in Tasks 3, 4, 6, 7
- **No placeholders:** every "TBD" / "TODO" was resolved before commit. Search this plan for those strings — should find zero.
- **Type consistency:** `email_verified` is `number` (0 or 1) everywhere — D1 column type INTEGER, TS type number, JSON type number. `userHasPassword` is boolean throughout.
- **Frequent commits:** each task ends with a commit. Total: 9 commits + 1 PR.

If any gap surfaces during execution, pause and patch the plan before continuing.

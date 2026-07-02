# Known issues — advocatemcp (v1)

Append-only log: new entries go at the bottom, one block per PR, blank line between blocks. Existing lines are never edited or deleted.

## 2026-07-01 — RESOLVED: ADMIN_SECRET credential exposure (closed end-to-end)

- **Exposure.** The value of the `ADMIN_SECRET` env var was embedded in client-served JavaScript on `GET /onboard` (`worker/src/routes/onboardPage.ts:901`), and was also present in git history (commit `cf06bc3`) and in one doc file.
- **Fix (PR #279, merged + deployed 2026-07-01).** Removed the client-side embed, moved `GET /onboard` and `POST /api/onboard/basic` behind admin-session auth (302-to-`/login` verified live post-deploy), and scrubbed the doc copy.
- **Rotation (2026-07-01, operator).** `ADMIN_SECRET` was rotated via `wrangler secret put`. The old value is now invalid everywhere — including anywhere it appears in git history — so the historical exposure is dead, not merely hidden.
- **Operator note.** Any tooling that sends the `X-Admin-Secret` header or an admin `Authorization: Bearer` token (scripts, runbook curl commands, CI, cron/sync callers) must be updated to the new `ADMIN_SECRET` value; requests carrying the old value will be rejected.

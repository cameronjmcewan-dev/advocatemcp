# Connect Cloudflare Pages to Git (one-time setup)

The `advocatemcp-site` Pages project is currently **Direct Upload** —
it deploys only when someone runs `wrangler pages deploy site` from an
authenticated laptop. Every merge to `main` with frontend changes
requires that manual step; if the operator forgets, the site falls
out of sync with the backend (which Railway auto-deploys).

This guide converts the project to **Git-connected**, so every merge
to `main` triggers an automatic Pages build + deploy. Two-minute
one-time setup.

---

## Why not just retrofit the existing project?

Cloudflare Pages doesn't let you add a Git connection to a project
that was created as Direct Upload. You have to:

1. Create a new Git-connected project alongside
2. Move the custom domain (`advocatemcp.com`, `www.advocatemcp.com`)
   from the old project to the new one
3. Delete (or retire) the old Direct Upload project

Only step 2 carries any live-traffic risk; it's a ~30-second DNS
transition that CF handles on their edge.

---

## Prerequisites

- Access to the Cloudflare dashboard for the account that owns
  `advocatemcp.com`
- Admin rights on the `cameronjmcewan-dev/advocatemcp` GitHub repo
- The `advocatemcp-site` Direct Upload project must be running
  (don't delete it until the new project is verified live)

---

## Steps

### 1. Create the Git-connected Pages project

1. `dash.cloudflare.com` → **Workers & Pages** → **Create application** → **Pages** tab → **Connect to Git**
2. Authorize Cloudflare on GitHub (if not already)
3. Select the `cameronjmcewan-dev/advocatemcp` repo
4. On the build config screen:
   - **Project name:** `advocatemcp-site-v2` (any name — the original is still `advocatemcp-site`; pick anything that's different)
   - **Production branch:** `main`
   - **Build command:** *(leave empty — pure static site, no build step)*
   - **Build output directory:** `site`
   - **Root directory:** *(leave empty, defaults to repo root)*
5. Click **Save and Deploy**

First deploy should complete in 20–60 seconds. Verify it at the
`*.pages.dev` URL the dashboard gives you. Make sure `/audit`, `/r/<any-id>`,
and `/advocate-context.js` all load correctly.

### 2. Move the custom domain over

While both projects exist, `advocatemcp.com` still points at the old
Direct Upload project. To transfer:

1. In the **old** `advocatemcp-site` project:
   **Custom domains** tab → find `advocatemcp.com` → **Remove**
2. Confirm. DNS will briefly fall back to the Cloudflare Pages default
   for an unmapped domain (an error page) — this lasts seconds.
3. Immediately in the **new** `advocatemcp-site-v2` project:
   **Custom domains** tab → **Set up a custom domain** → enter
   `advocatemcp.com` → CF detects the existing DNS CNAME and claims it
   on the new project
4. Repeat for `www.advocatemcp.com`

Total downtime: well under a minute, and no DNS changes are needed
(the CNAME records already point at Pages' edge; CF just re-maps
which project the edge serves for that hostname).

### 3. Verify the new project serves production

After the custom domain transfer:

```bash
curl -sI https://advocatemcp.com/ | head -3
curl -s https://advocatemcp.com/js/audit.js | grep -c "renderLeaderboard"
# expected: 2+ (new file with the leaderboard code)
```

If curl still returns stale content, give it 1–2 min for the edge
cache to invalidate.

### 4. Delete (or archive) the old project

Once the new project is serving traffic without issues:

1. `advocatemcp-site` → **Settings** → scroll to bottom → **Delete project**

Or, if you want to keep the old deployment history around as a fallback,
just leave it. It has no custom domains attached now, so no traffic
reaches it.

---

## What changes in the dev loop

**Before (today):**
```
1. Merge PR to main
2. Railway auto-deploys backend     ← ✓ automatic
3. SSH to laptop, wrangler pages deploy    ← ❌ manual, forgettable
```

**After:**
```
1. Merge PR to main
2. Railway auto-deploys backend     ← ✓ automatic
3. Cloudflare Pages auto-builds + deploys  ← ✓ automatic
```

Every future merge ships both backend + frontend in under 2 minutes
with zero operator action.

---

## Gotchas

- **`_redirects` file is honored.** The new project picks up
  `site/_redirects` the same way the old one did, so the
  `/r/* → /r.html?id=:splat 200` rewrite keeps working.
- **Preview deployments.** Git-connected projects build a preview for
  every PR. These use `*.advocatemcp-site-v2.pages.dev` URLs; they
  don't affect production. Can be used for reviewing visual changes
  before merging.
- **Build logs** show up in the Pages dashboard under **Deployments**
  → each build has logs, which are useful if a future build step
  breaks (none today, since the site is pure static).
- **Branch deploys.** Commits to non-`main` branches build to preview
  URLs. If you don't want this (e.g. to save build minutes on the free
  plan), disable in **Settings** → **Builds & deployments**.

---

## Rollback

If the new project ever has an issue the old one didn't:

1. Re-add `advocatemcp.com` custom domain on the OLD project
2. Remove it from the new project
3. DNS stays the same; CF flips which project serves the edge

Takes under a minute. The old project's `advocatemcp-site` bucket of
deployment history is still intact until you delete it in step 4 above.

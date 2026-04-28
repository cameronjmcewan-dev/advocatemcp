# GitHub Actions — deploy automation

Two workflows live here, one for each surface that ships independently.

## `deploy-pages.yml`

Re-creates the auto-deploy behavior the Cloudflare Pages project
`advocatemcp-site` is missing (the project's Git Provider is set to
"No" in the dashboard, which silently disables pushes-trigger-deploy).

Runs on:
- `push` to `main` that touches `site/**`
- `pull_request` that touches `site/**` (preview deploy + PR comment)
- manual `workflow_dispatch` (emergency button)

## `deploy-worker.yml`

Auto-deploys the Cloudflare Worker (`worker/`) on `main` merges.
Worker has no native auto-deploy; without this workflow every change
ships only when a developer remembers to run `wrangler deploy`.

Runs on:
- `push` to `main` that touches `worker/**` → typecheck + deploy
- `pull_request` that touches `worker/**` → typecheck only (no deploy)
- manual `workflow_dispatch`

## Required repo secrets

Both workflows depend on the same two secrets. Set them once in the
repo settings (Settings → Secrets and variables → Actions → New
repository secret) and both workflows pick them up.

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Token with **Workers Scripts: Edit** + **Pages: Edit** + **Account: Read** |
| `CLOUDFLARE_ACCOUNT_ID` | `7d93ac7288642081ef8f0e8e406c34a2` |

### Creating the API token

1. Go to <https://dash.cloudflare.com/profile/api-tokens>
2. Click **Create Token** → **Create Custom Token**
3. Permissions:
   - **Account** → **Cloudflare Pages** → **Edit**
   - **Account** → **Workers Scripts** → **Edit**
   - **Account** → **Account Settings** → **Read**
4. Account Resources → **Include: Specific account** → your AdvocateMCP account
5. **Create Token**, copy it once (it won't be shown again)
6. From the repo:
   ```bash
   gh secret set CLOUDFLARE_API_TOKEN
   # paste the token when prompted, then:
   gh secret set CLOUDFLARE_ACCOUNT_ID --body 7d93ac7288642081ef8f0e8e406c34a2
   ```

After that, every `main` merge auto-deploys the affected surface.

## Manual fallback

If a workflow run fails or you need to ship something urgently
without going through CI, the original commands still work:

```bash
# Site
npx wrangler pages deploy site --project-name=advocatemcp-site --branch=main

# Worker
cd worker && npx wrangler deploy
```

These bypass CI but produce identical deploys — they share the same
wrangler binary the workflows invoke.

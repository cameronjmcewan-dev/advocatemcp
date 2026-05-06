# Pre-public-flip checklist

Run through every line before flipping any private repo to public. Born from the 2026-05-05 incident where customer names + financial targets were exposed for ~1 hour.

## Customer privacy

- [ ] `git grep -i "<every-paying-customer-name>" -- '*.md' '*.ts' '*.js' '*.json'` — zero results
- [ ] `git grep -E '@(customer-domain-1|customer-domain-2)\.com' -- '*.md' '*.ts' '*.js' '*.json'` — zero results
- [ ] No customer slugs in test fixtures (`experiments/`, `*.test.ts` snapshots, `*.json` fixtures)
- [ ] Every file in `docs/` reviewed for handoff notes / sprint planning / launchpad applications
- [ ] CLAUDE.md and IMPLEMENTATION_PLAN.md scanned for customer references and slug literals

## Strategic content

- [ ] No financial targets (MRR, ARR, customer counts, revenue projections, runway, burn)
- [ ] No competitor analysis with named competitors
- [ ] No fundraising specifics (amounts, target investors, timeline, valuation)
- [ ] No exit / acquisition strategy
- [ ] No vendor cost breakdowns (Anthropic per-token, Twilio per-SMS, Resend per-email)
- [ ] No drafts of pitch decks, applications, or strategy memos

## Secrets

- [ ] `git ls-files | xargs grep -lE '(sk_live_|sk_test_[A-Za-z0-9]{20}|whsec_[A-Za-z0-9]{20}|gho_|ghp_|AKIA[0-9A-Z]{16}|BEGIN .*PRIVATE KEY)'` — every match is a placeholder or test fixture
- [ ] `.gitignore` covers all `.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`
- [ ] No committed `.DS_Store`, `node_modules/`, build artifacts, sqlite `.db` files
- [ ] `git log --all -p -S '<a-real-key-prefix-from-rotation-history>' -- '*.env*'` — no live keys in history

## Other operational

- [ ] No customer phone numbers (real or test) — verify all phones use `555-XXXX` fake range
- [ ] No internal Slack/Discord webhooks
- [ ] No internal admin emails distinguishable from public ones
- [ ] No PR / issue references that name customers in titles or descriptions

## Done

- [ ] `gh repo edit --visibility public --accept-visibility-change-consequences`
- [ ] Verify the URL loads in a private/incognito window
- [ ] Document the public-flip date in `docs/followups.md`
- [ ] Re-run the secret/customer scan one more time within 24 hours, in case search indexes pick up anything missed

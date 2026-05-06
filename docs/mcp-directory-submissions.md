# MCP Directory Submissions — Pre-filled Answers

Copy-paste targets for submitting AdvocateMCP to each of the major MCP
directories. One section per directory with the exact fields they ask for.

Submit in this order: **MCP Registry (fast, self-serve) → Smithery → PulseMCP → Anthropic Connectors Directory**.
Each later submission benefits from showing the earlier listings as proof of
ecosystem presence; Anthropic's review is the slowest and most selective so it
goes last with maximum supporting evidence.

Last validated: 2026-05-04 (Phase 1 expanded the tool surface from 6 → 10 on Apr 30 2026; Anthropic + MCP Registry sections corrected at the same time).

---

## Shared details (reused in every submission)

| Field | Value |
|---|---|
| **Project name** | AdvocateMCP |
| **Display name** | Advocate |
| **Endpoint URL** | `https://api.advocatemcp.com/mcp` |
| **Transport** | Streamable HTTP (JSON-RPC 2.0 + SSE) |
| **Public spec page** | `https://advocatemcp.com/mcp.html` |
| **Manifest URL** | `https://api.advocatemcp.com/.well-known/mcp.json` |
| **Category** | Local business / SMB directory / Customer discovery |
| **License** | Proprietary (hosted SaaS); SDK/manifest spec is open |
| **Maintainer email** | max@advocate-mcp.com |
| **Repository** | `https://github.com/cameronjmcewan-dev/advocatemcp` |
| **Logo** | `https://advocatemcp.com/icon-512.png` (512×512 PNG) |

### Short description (≤ 140 chars)

> Search and query a directory of local businesses' AI-ready advocate agents. Platform-neutral, zero setup per AI assistant.

### Medium description (≤ 500 chars)

> AdvocateMCP is the MCP layer for local businesses. Any AI assistant connects once and gains real-time access to verified business profiles, booking slots, price quotes, and agent handoffs. Each business publishes one canonical profile (hours, services, credentials, lead-routing preferences); Advocate turns that into a citation-ready agent that answers on behalf of the business across every AI surface. Attribution is signed and tracked end-to-end.

### Long description (copy the landing page for anything ≥ 500 chars)

See `site/mcp.html` — the live version on `advocatemcp.com/mcp.html` is the
canonical long-form description.

### Example queries (for "how is this used?" fields)

1. "Find me a plumber in Boise who handles 24/7 emergencies."
2. "What does this copywriting agency charge for a 4-email welcome sequence?"
3. "Book a 30-minute consultation with this law firm on Thursday afternoon."
4. "What's the best-rated DTC email agency in Austin?"
5. "Is the locksmith on 5th Ave actually licensed and insured?"
6. "What's their cancellation policy if I need to reschedule the day before?"
7. "Have them call me back about a custom quote — I'm at 555-0123."
8. "Sign me up for new-service emails from this medspa."

### Tools list (10 tools — for forms that enumerate the surface)

Discovery (open, no auth):

- `search_businesses` — search by category, name, or location
- `query_business_agent` — query a specific business's AI agent
- `get_availability` — 30-min slot windows derived from `hours_json`
- `get_quote` — price quote from `pricing_json_v2` (deterministic ranges first, LLM fallback labeled "estimate")
- `get_credentials` — self-reported licenses, insurance, bonding, certifications (trust-sensitive verticals)
- `get_cancellation_policy` — verbatim cancellation/refund/no-show policy + agent guidance when missing

Transactional (per-tenant Bearer required — agent-to-agent surface):

- `reserve_slot` — 15-min HELD reservation, returns signed `confirmation_token`
- `initiate_handoff` — SMS/email to human (Twilio) OR signed continuation URL for agent-to-agent
- `request_callback` — push user contact to business; idempotency-keyed within 24h to prevent spam
- `subscribe_to_updates` — double-opt-in email subscription (CAN-SPAM/GDPR compliant)

All 10 tools carry MCP-spec annotations (`title`, `readOnlyHint`, `destructiveHint`, `openWorldHint`); Anthropic explicitly requires `title`.

---

## 1. Smithery ([smithery.ai](https://smithery.ai))

**Submission path:** smithery.ai/submit → "New MCP server"

| Field | Answer |
|---|---|
| Name | `AdvocateMCP` |
| Slug | `advocate-mcp` |
| Description (short) | See "Short description" above |
| Endpoint | `https://api.advocatemcp.com/mcp` |
| Transport | Streamable HTTP |
| Tags | `local-business`, `directory`, `smb`, `lead-gen`, `attribution`, `booking`, `quotes`, `credentials`, `callbacks` |
| Auth required | Discovery: none. Transactions: per-tenant Bearer. |
| Homepage | `https://advocatemcp.com/mcp.html` |
| GitHub | `https://github.com/cameronjmcewan-dev/advocatemcp` |
| Contact | max@advocate-mcp.com |
| Example queries | See list above |

**Review expectation:** 3–7 day turnaround. Reviewer may ping to
confirm uptime — the server is always-on, so hit `GET /mcp` and they'll see
the initialize handshake.

---

## 2. PulseMCP ([pulsemcp.com](https://www.pulsemcp.com))

**Submission path:** pulsemcp.com/submit

PulseMCP's form asks for many of the same fields as Smithery, plus:

| Field | Answer |
|---|---|
| Server type | Remote (Streamable HTTP), not a local binary |
| Deployment | Hosted by maintainer on Cloudflare + Railway |
| Pricing | Free to connect; per-business subscription model (not per-API-call) |
| Rate limits | 60 RPM per IP for discovery; 10 RPM for transactional tools |
| Stability claim | Production |
| Changelog URL | `https://github.com/cameronjmcewan-dev/advocatemcp/releases` (once we start tagging) |

**Notable extras:** PulseMCP encourages a YouTube or demo link. Record a
90-second screen-cap of Claude Desktop using the server to find the first paying tenant and
run a query; link it in the submission. Skip if no recording yet — the
listing will still be accepted, just without a demo banner.

---

## 3. Anthropic Connectors Directory

**Submission path:** Google Form at `https://clau.de/mcp-directory-submission`
(remote/hosted MCPs). Desktop extensions submit separately at
`https://clau.de/desktop-extention-submission` — not us; we're a remote MCP.

**Review timeline:** ~2 weeks manual review by the Anthropic team. Status updates via dashboard (rolling out) or `mcp-review@anthropic.com` for escalations.

**Form field map:**

| Field | Answer |
|---|---|
| Server name | `AdvocateMCP` |
| Server URL | `https://api.advocatemcp.com/mcp` |
| Tagline | "Search and query a directory of local businesses' AI-ready advocate agents." |
| Description | See "Medium description" above |
| Use cases | See example queries above |
| Authentication type | None (discovery surface). Write tools require per-tenant Bearer — see test instructions below. |
| Transport | Streamable HTTP (JSON-RPC 2.0) |
| Read/write capabilities | 6 read-only tools, 4 write tools (transactional, agent-to-agent only) |
| Connection requirements | None for discovery; per-business Bearer for `reserve_slot`/`initiate_handoff`/`request_callback`/`subscribe_to_updates` |
| Data handling | No PII written to long-term analytics; signed attribution tokens only |
| Third-party connections | Anthropic API (LLM responses), Twilio (handoff SMS/email), Resend (email) |
| Health data | None |
| Category | Local business / SMB directory / Customer discovery |
| Tools list | All 10 (see Tools list above), all with `title`/`readOnlyHint`/`destructiveHint`/`openWorldHint` annotations confirmed |
| Documentation URL | `https://advocatemcp.com/mcp.html` |
| Privacy policy | `https://advocatemcp.com/privacy` |
| Terms | `https://advocatemcp.com/terms` |
| Support channel | `max@advocate-mcp.com` |
| Test account | See "Reviewer test instructions" below |
| GA date | Submission day |
| Tested surfaces | Claude Desktop (verified); Claude.ai (screenshots) |
| Logo | `https://advocatemcp.com/icon-512.png` (512×512 PNG) |
| Favicon | `https://advocatemcp.com/favicon.ico` (verify before submission) |
| Promotional screenshots | 3–5 PNG ≥1000px, cropped to Claude.ai response (drop in `docs/brand/screenshots/`) |
| Compliance checklists | Confirm directory policy, technical requirements, docs, testing all met |

### Reviewer test instructions (copy into the form's test-account field)

```
1. Add to Claude Desktop's claude_desktop_config.json:
   { "mcpServers": { "advocate": { "url": "https://api.advocatemcp.com/mcp", "transport": "http" } } }
2. Restart Claude Desktop. Try these prompts:
   - "Search for marketing agencies in Boise" → search_businesses
   - "What does this copywriting agency charge for a welcome email sequence?" → query_business_agent
   - "When is this law firm available Thursday afternoon?" → get_availability
   - "Is this copywriting agency licensed and insured?" → get_credentials
   - "What's their cancellation policy?" → get_cancellation_policy
3. Write tools (reserve_slot, initiate_handoff, request_callback,
   subscribe_to_updates) require per-business Bearer auth — they're an
   agent-to-agent surface for AI booking on behalf of a user, not exposed
   to direct end-user Claude.ai sessions. Reviewer can verify registration
   via tools/list RPC. Functional tests require business onboarding (out of scope).
4. Manifest: https://api.advocatemcp.com/.well-known/mcp.json
5. Public spec page: https://advocatemcp.com/mcp.html
6. Rate limit posture: 60 req/min/IP (Cloudflare DO-backed) declared in manifest
```

**Common rejection triggers and pre-empted responses:**

- **"Auth model is OAuth?"** — No. Discovery tools are open (auth=none). Write tools are agent-to-agent and use per-tenant Bearer issued at business registration. End-users in Claude.ai never need credentials. OAuth 2.0 doesn't fit because the "user" of write tools is a business owner, not a Claude.ai end-user.
- **"Rate limits not documented"** — Manifest declares `per_ip_per_minute: 60` and per-tier ceilings. `mcp.html` Rate Limits section explains the DO-backed enforcement.
- **"Privacy policy thin"** — verify `https://advocatemcp.com/privacy` covers data collection, retention, third-party sharing, contact email before submission. **Most common immediate-rejection trigger** per Anthropic's own guidance.
- **"Tool annotations missing"** — All 10 tools carry `title` + `readOnlyHint`/`destructiveHint`/`openWorldHint`. Verified by drift test in `server/src/manifest/descriptor.test.ts`.

---

## 4. MCP Registry (registry.modelcontextprotocol.io)

**Submission path:** Self-serve CLI publish via the `mcp-publisher` binary. Domain-authenticated via DNS TXT or HTTP `/.well-known/` proof. Goes live in hours, no manual review queue.

**Why submit here too:** The MCP Registry is the official, vendor-neutral registry — Anthropic is a contributor but it's community-governed. Listing here first creates ecosystem proof the Anthropic reviewer can cite.

**Server.json file:** Already drafted at [docs/mcp-registry-server.json](mcp-registry-server.json) — name `com.advocatemcp/advocate`, declares one streamable-http remote at `https://api.advocatemcp.com/mcp`, references the GitHub repo. Update the `version` field on each republish.

### Setup steps

**1. Install `mcp-publisher`** (one-time, macOS/Linux):

```bash
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" \
  | tar xz mcp-publisher \
  && sudo mv mcp-publisher /usr/local/bin/
mcp-publisher --help
```

Or via Homebrew: `brew install mcp-publisher`.

**2. Authenticate with the `com.advocatemcp` namespace via HTTP method** (recommended — uses our existing `/.well-known/` infrastructure on advocatemcp.com):

```bash
# Generate Ed25519 key pair (run from a secure local directory; key.pem is sensitive)
openssl genpkey -algorithm Ed25519 -out key.pem

# Generate the auth file
PUBLIC_KEY="$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
echo "v=MCPv1; k=ed25519; p=${PUBLIC_KEY}" > mcp-registry-auth
```

Then host `mcp-registry-auth` at `https://advocatemcp.com/.well-known/mcp-registry-auth`. Drop it into `site/.well-known/mcp-registry-auth` and redeploy the site (Cloudflare Pages picks up the file automatically since `/.well-known/` paths route through the site bucket).

```bash
# Verify it's live before login
curl -sI https://advocatemcp.com/.well-known/mcp-registry-auth | head -3
# Expected: HTTP/2 200, content-type: text/plain (or application/octet-stream)
```

Then log in:

```bash
PRIVATE_KEY="$(openssl pkey -in key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')"
mcp-publisher login http --domain "advocatemcp.com" --private-key "${PRIVATE_KEY}"
# Expected: ✓ Successfully logged in
```

(Alternative: DNS method using a TXT record on advocatemcp.com. Slower because DNS propagation can take several minutes, but doesn't require a redeploy. See `https://modelcontextprotocol.io/registry/authentication` for the full DNS recipe.)

**3. Publish:**

`mcp-publisher` defaults to `./server.json` and accepts a positional path. There is no `--file=` flag (despite what some third-party docs say). Publish via:

```bash
cd /Users/cameronmcewan/Desktop/advocate/advocatemcp
mcp-publisher publish docs/mcp-registry-server.json
# Expected:
# Publishing to https://registry.modelcontextprotocol.io...
# ✓ Successfully published
# ✓ Server com.advocatemcp/advocate version 1.0.0
```

To pre-validate without publishing (verified 2026-05-04 against the live registry schema): `cp docs/mcp-registry-server.json server.json && mcp-publisher validate && rm server.json`. The `validate` command requires `./server.json` — copy in/out is a one-line workaround.

**4. Verify listing:**

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=com.advocatemcp/advocate" | jq
# Confirm name + remotes[0].url match
```

**5. Capture the registry URL** — paste it into the Anthropic submission's "tested surfaces" / "previous listings" field as ecosystem evidence.

### Republish workflow (after future tool surface changes)

1. Bump `"version"` in `docs/mcp-registry-server.json` (e.g. `1.0.0` → `1.1.0` if a tool was added)
2. Re-run `mcp-publisher publish --file=docs/mcp-registry-server.json` (auth state cached locally; no re-login needed)

The MCP Registry stores metadata only — it does NOT pull our `/.well-known/mcp.json` automatically. So tool annotation changes (like the `title` annotation added 2026-05-04) require a republish to be reflected on the registry side. The full tool catalog lives in our manifest, which clients fetch directly from `https://api.advocatemcp.com/.well-known/mcp.json`.

---

## Post-submission checklist

After each directory goes live:

1. Update `site/js/dashboard-surfaces.js` — change that directory's status
   badge from "Submission in progress" to "Live (listed X date)".
2. Add a backlink from `site/mcp.html` into the "On these directories"
   list (todo: add that section when the first listing lands).
3. Note the listing URL in `docs/followups.md` so future operator work
   knows where to check status.
4. Add a row to the AdvocateMCP GitHub README directory listings table.

## If a submission is rejected

Most common reasons + responses:

- **"Endpoint requires auth"** → re-emphasize that discovery tools
  (`search_businesses`, `query_business_agent`) are fully open. Only
  write-path tools require a per-tenant Bearer — which the directory
  reviewer doesn't need to test.
- **"Rate limits not documented"** → point them at `mcp.html` Rate
  Limits section + `/.well-known/mcp.json` which declares the limits
  machine-readably.
- **"No clear use case"** → send them the demo video OR run a live
  one-on-one via Zoom demonstrating Claude Desktop querying the first paying tenant.

## Outreach ordering rationale

Smithery has the highest throughput and fastest turnaround — get the
first listing there to prove the ecosystem bench. PulseMCP has stronger
editorial curation and will want to see at least one prior listing.
Anthropic's registry is the slowest and most selective; go last, when
the others are already live and can be cited as prior-art.

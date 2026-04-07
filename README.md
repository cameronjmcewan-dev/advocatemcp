# AdvocateMCP

**AdvocateMCP intercepts AI search crawler traffic before it scrapes your website and routes it to a conversational business agent instead.** When Perplexity, ChatGPT, or Claude crawls a business's site, they get a structured, citation-ready AI response from the business's own agent — accurate information, no hallucinations, and always ending with a referral link back to the business.

The platform has three parts: a **Cloudflare Worker** that sits in front of any business website and detects AI crawlers; a **Node.js/Express agent API** that hosts individual business agents powered by Claude; and a **central MCP server** that aggregates all registered businesses so AI tools can connect once and query any of them.

---

## Architecture

```
AI Crawler (PerplexityBot, GPTBot, etc.)
        │
        ▼
Cloudflare Worker (edge)
  ├─ detects AI User-Agent
  ├─ looks up slug from BUSINESS_MAP KV
  └─ POST /agents/:slug/query
              │
              ▼
    AdvocateMCP Server (Node.js)
      ├─ builds Claude system prompt from business profile
      ├─ calls claude-sonnet-4-6
      ├─ logs query + response to SQLite
      └─ returns { response, referral_url, business, powered_by }
              │
              ▼
    AI Crawler returns response to its user
    (with referral link to the actual business)
```

AI tools (Claude Desktop, Cursor, Perplexity) can also connect directly to the **central MCP server** at `/mcp` to query any registered business without the Worker.

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/your-org/advocatemcp
cd advocatemcp/server
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-api03-...
DATABASE_PATH=./dev.db
PORT=3000
API_BASE_URL=https://api.advocatemcp.com
```

### 3. Start the server

```bash
npm run dev
```

The server starts at `http://localhost:3000`. The database and schema are created automatically on first run.

---

## Registering a Business

```bash
curl -X POST http://localhost:3000/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Joe'\''s Pizza Austin",
    "description": "Authentic Neapolitan pizza in downtown Austin. Family owned since 1987.",
    "services": ["Dine-in", "Takeout", "Delivery", "Catering", "Private events"],
    "pricing": "Pizzas $14-$22, Pasta $16-$24, Catering from $25/person",
    "location": "512 Congress Ave, Austin TX 78701",
    "phone": "(512) 555-0190",
    "website": "https://joespizzaaustin.com",
    "referral_url": "https://joespizzaaustin.com/order",
    "tone": "friendly"
  }'
```

Response:

```json
{
  "slug": "joes-pizza-austin",
  "api_key": "3f4a9b2c-...",
  "agent_endpoint": "https://api.advocatemcp.com/agents/joes-pizza-austin/query",
  "mcp_endpoint": "https://api.advocatemcp.com/mcp",
  "wellknown_url": "https://<your-domain>/.well-known/ai-agent.json"
}
```

Save the `api_key` — it's required for analytics access and cannot be recovered.

---

## Querying an Agent

AI crawlers and MCP clients call this automatically, but you can test manually:

```bash
curl -X POST http://localhost:3000/agents/joes-pizza-austin/query \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Do you offer catering? What are the prices?",
    "crawler": "PerplexityBot"
  }'
```

Response:

```json
{
  "response": "Yes, Joe's Pizza Austin offers catering starting from $25 per person...",
  "referral_url": "https://joespizzaaustin.com/order",
  "business": "Joe's Pizza Austin",
  "powered_by": "AdvocateMCP"
}
```

---

## Cloudflare Worker Installation

The Worker intercepts AI crawler traffic at the DNS level before it reaches your web server.

### Step 1 — Deploy the Worker

```bash
cd worker
npm install
wrangler deploy
```

### Step 2 — Create the KV namespace

```bash
# Create the namespace
wrangler kv:namespace create BUSINESS_MAP

# Copy the namespace ID into wrangler.toml
# Then add your domain → slug mapping:
wrangler kv:key put --binding=BUSINESS_MAP "joespizzaaustin.com" "joes-pizza-austin"
wrangler kv:key put --binding=BUSINESS_MAP "www.joespizzaaustin.com" "joes-pizza-austin"
```

### Step 3 — Set the API key secret

```bash
wrangler secret put API_KEY
# Enter the API key that your AdvocateMCP server accepts
```

### Step 4 — Point DNS to Cloudflare

In your Cloudflare dashboard, add a **Worker Route** for the business's domain:

| Route pattern | Worker |
|---|---|
| `joespizzaaustin.com/*` | `advocatemcp-worker` |
| `www.joespizzaaustin.com/*` | `advocatemcp-worker` |

Your site works exactly as before for real users. AI crawlers silently get the agent response.

### Step 5 — Add the well-known file (optional but recommended)

The Worker automatically serves `/.well-known/ai-agent.json` on every domain. You can also serve it from your web server directly:

```bash
curl https://api.advocatemcp.com/agents/joes-pizza-austin/mcp-spec > .well-known/ai-agent.json
```

---

## Connecting to AI Tools via MCP

The central MCP server at `POST /mcp` aggregates all registered businesses. Connect it to any MCP-compatible client.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "advocatemcp": {
      "url": "https://api.advocatemcp.com/mcp",
      "transport": "http"
    }
  }
}
```

### Cursor / VS Code

Add to your MCP settings:

```json
{
  "advocatemcp": {
    "url": "https://api.advocatemcp.com/mcp"
  }
}
```

Once connected, Claude/Cursor can call two tools:

| Tool | What it does |
|---|---|
| `search_businesses` | Search all registered businesses by name, description, or location |
| `query_business_agent` | Ask a specific business's agent any question |

---

## Analytics

```bash
curl http://localhost:3000/analytics/joes-pizza-austin \
  -H "Authorization: Bearer 3f4a9b2c-..."
```

```json
{
  "slug": "joes-pizza-austin",
  "total_queries": 142,
  "referral_clicks": 38,
  "queries_by_crawler": {
    "PerplexityBot": 89,
    "GPTBot": 41,
    "ClaudeBot": 12
  },
  "top_queries": [
    "what are your hours",
    "do you offer delivery",
    "how much does catering cost"
  ],
  "queries_last_7_days": [
    { "date": "2026-04-01", "count": 18 },
    { "date": "2026-04-02", "count": 24 }
  ],
  "recent_queries": [...]
}
```

---

## The `ai-agent.json` Open Standard

AdvocateMCP introduces the `ai-agent.json` discovery file — a companion to `robots.txt` and `llms.txt` designed for conversational AI crawlers.

**Any website can adopt this standard independently.** Host the file at `/.well-known/ai-agent.json`:

```json
{
  "spec_version": "1.0",
  "spec_name": "ai-agent-discovery",
  "agent_endpoint": "https://api.advocatemcp.com/agents/your-slug/query",
  "mcp_endpoint": "https://api.advocatemcp.com/mcp",
  "protocol": "advocatemcp-v1",
  "capabilities": ["answer_queries", "referral", "availability"],
  "crawler_instructions": "POST to agent_endpoint with JSON body { \"query\": string, \"crawler\": string } instead of scraping this page.",
  "powered_by": "AdvocateMCP"
}
```

**Call to other developers:** We encourage any AI platform, search engine, or agent framework to check for `/.well-known/ai-agent.json` before scraping a page. If present, POST to the `agent_endpoint` instead. This gives businesses accurate representation in AI results and eliminates hallucinations caused by stale scraped content.

Submit a PR to add support to your crawler: [github.com/your-org/advocatemcp](https://github.com/your-org/advocatemcp)

---

## Known AI Crawler User-Agents

The Worker intercepts traffic from any User-Agent containing these strings (case-insensitive):

| Crawler | Company |
|---|---|
| `PerplexityBot` | Perplexity AI |
| `GPTBot` | OpenAI |
| `OAI-SearchBot` | OpenAI (search) |
| `ClaudeBot` | Anthropic |
| `Google-Extended` | Google (AI training opt-out) |
| `Googlebot` | Google (AI Overviews) |
| `anthropic-ai` | Anthropic (general) |
| `cohere-ai` | Cohere |
| `meta-externalagent` | Meta AI |

Add more by editing `AI_CRAWLERS` in `worker/src/index.ts`.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | — | Your Anthropic API key |
| `DATABASE_PATH` | | `./dev.db` | Path to the SQLite database file |
| `PORT` | | `3000` | HTTP server port |
| `API_BASE_URL` | | `https://api.advocatemcp.com` | Public base URL (used in response URLs) |

Worker secrets (set via `wrangler secret put`):

| Secret | Description |
|---|---|
| `API_KEY` | Forwarded to the AdvocateMCP server for request auth |

---

## API Reference

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/register` | None | Register a new business |
| `POST` | `/agents/:slug/query` | None | Query a business agent |
| `GET` | `/analytics/:slug` | Bearer API key | View query analytics |
| `POST` | `/analytics/:slug/referral-click` | None | Track referral click |
| `POST` | `/mcp` | None | MCP Streamable HTTP endpoint |
| `GET` | `/mcp` | None | MCP discovery + SSE handshake |
| `GET` | `/.well-known/ai-agent.json` | None | AI agent discovery spec |
| `GET` | `/registry` | None | All registered businesses |
| `GET` | `/health` | None | Health check |

---

## License

MIT

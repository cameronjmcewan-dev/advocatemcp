/**
 * /demo — Public AI visibility demo page (no auth required)
 *
 * Routes:
 *   GET /demo              — search landing
 *   GET /demo/search?q=    — fuzzy match → redirect to /demo/:slug or show nomatch
 *   GET /demo/:slug        — side-by-side comparison + bot simulation (deep-linkable)
 */

import type { Env } from "../types";

// ── Types ──────────────────────────────────────────────────────────────────

interface Profile {
  slug: string;
  name: string;
  website: string | null;
  location: string | null;
  description: string;
  category: string | null;
  star_rating: number | null;
  review_count: number | null;
}

interface RegistryEntry {
  slug: string;
  name: string;
  website: string | null;
  location: string | null;
  category: string | null;
  description: string;
}

interface GlobalAnalytics {
  total_queries: number;
  total_referral_clicks: number;
  queries_by_crawler: Record<string, number>;
}

// ── Public handler ─────────────────────────────────────────────────────────

export async function handleDemo(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (request.method !== "GET") return null;

  if (pathname === "/demo") return demoLanding(url, env);
  if (pathname === "/demo/search") return demoSearch(url, env);

  const m = pathname.match(/^\/demo\/([a-z0-9][a-z0-9-]{0,59})$/);
  if (m) return demoResult(m[1], env);

  return null;
}

// ── GET /demo ──────────────────────────────────────────────────────────────

async function demoLanding(url: URL, env: Env): Promise<Response> {
  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  const regRes = await fetch(`${base}/registry`).catch(() => null);
  const registry: RegistryEntry[] = regRes?.ok
    ? (await regRes.json() as { businesses: RegistryEntry[] }).businesses.slice(0, 6)
    : [];
  return htmlResp(landingHtml(registry, url.searchParams.get("error")));
}

// ── GET /demo/search?q= ────────────────────────────────────────────────────

async function demoSearch(url: URL, env: Env): Promise<Response> {
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (!q) return redir("/demo");

  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  const regRes = await fetch(`${base}/registry`).catch(() => null);
  const registry: RegistryEntry[] = regRes?.ok
    ? (await regRes.json() as { businesses: RegistryEntry[] }).businesses
    : [];

  const match = fuzzyMatch(q, registry);
  if (match) return redir(`/demo/${match.slug}`);

  // No match — try to fetch the website if q looks like a domain
  const website =
    q.includes(".") && !q.includes(" ")
      ? q.startsWith("http") ? q : `https://${q}`
      : null;
  const rawText = website ? await fetchVisibleText(website) : null;
  return htmlResp(nomatchHtml(q, website, rawText, registry));
}

// ── GET /demo/:slug ────────────────────────────────────────────────────────

async function demoResult(slug: string, env: Env): Promise<Response> {
  const base = env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
  const apiKey = env.API_KEY ?? "";

  const [profileRes, queryRes, analyticsRes] = await Promise.allSettled([
    fetch(`${base}/agents/${slug}/profile`, { headers: { "X-API-Key": apiKey } }),
    fetch(`${base}/agents/${slug}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({
        query:
          "Tell me about this business. What services do they offer, what makes them stand out, and how can someone get in touch or learn more?",
        crawler: "GPTBot",
      }),
    }),
    fetch(`${base}/analytics`, { headers: { "X-API-Key": apiKey } }),
  ]);

  // Business not found → nomatch landing
  if (profileRes.status === "rejected" || !profileRes.value.ok) {
    return redir(`/demo/search?q=${encodeURIComponent(slug)}`);
  }

  const profile = (await profileRes.value.json()) as Profile;

  const agentRaw =
    queryRes.status === "fulfilled" && queryRes.value.ok
      ? ((await queryRes.value.json()) as Record<string, unknown>)
      : null;

  const analytics =
    analyticsRes.status === "fulfilled" && analyticsRes.value.ok
      ? ((await analyticsRes.value.json()) as GlobalAnalytics)
      : null;

  // Fetch homepage visible text (best-effort, 3 s timeout)
  const rawText = profile.website ? await fetchVisibleText(profile.website) : null;

  // Build display JSON — trim long response text for readability
  const displayData: Record<string, unknown> = {};
  if (agentRaw) {
    if (typeof agentRaw.response === "string") {
      displayData.response =
        agentRaw.response.length > 300
          ? agentRaw.response.slice(0, 300) + "…"
          : agentRaw.response;
    }
    if (agentRaw.business)     displayData.business     = agentRaw.business;
    if (agentRaw.intent)       displayData.intent       = agentRaw.intent;
    if (agentRaw.referral_url) displayData.referral_url = agentRaw.referral_url;
    if (agentRaw.timestamp)    displayData.timestamp    = agentRaw.timestamp;
    if (agentRaw.powered_by)   displayData.powered_by   = agentRaw.powered_by;
  }

  return htmlResp(resultHtml(slug, profile, displayData, agentRaw !== null, rawText, analytics));
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fuzzyMatch(q: string, businesses: RegistryEntry[]): RegistryEntry | null {
  const ql = q.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const qw = q.toLowerCase().trim();
  return (
    businesses.find((b) => b.slug === ql || b.slug === qw) ??
    businesses.find((b) => b.name.toLowerCase() === qw) ??
    businesses.find((b) => b.slug.includes(ql) || ql.includes(b.slug)) ??
    businesses.find(
      (b) =>
        b.name.toLowerCase().includes(qw) ||
        qw.includes(b.name.toLowerCase().split(" ")[0])
    ) ??
    null
  );
}

async function fetchVisibleText(url: string): Promise<string | null> {
  try {
    const res = await Promise.race([
      fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; AdvocateMCP/1.0)" },
        redirect: "follow",
      }),
      new Promise<never>((_, r) =>
        setTimeout(() => r(new Error("timeout")), 3000)
      ),
    ]) as Response;
    if (!res.ok) return null;
    const raw = await res.text();
    return stripHtml(raw);
  } catch {
    return null;
  }
}

function stripHtml(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#[0-9]+;/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/**
 * Server-side JSON syntax highlighter.
 * Works on raw JSON — HTML special chars only appear inside string values,
 * which are captured by the regex and escaped inside the replacement fn.
 * Structural JSON chars ({, }, [, ], ,, :) contain no HTML special chars.
 */
function syntaxHighlight(json: string): string {
  return json.replace(
    /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      const e = match
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      if (/^"/.test(match)) {
        return /:$/.test(match)
          ? `<span class="jk">${e}</span>`   // key
          : `<span class="js">${e}</span>`;  // string value
      }
      if (/true|false|null/.test(match)) return `<span class="jb">${e}</span>`;
      return `<span class="jn">${e}</span>`; // number
    }
  );
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function redir(loc: string): Response {
  return new Response(null, { status: 302, headers: { Location: loc } });
}

function htmlResp(body: string): Response {
  return new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// ── Shared CSS (result + nomatch pages) ───────────────────────────────────

function demoStyles(): string {
  return `<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#0d1117;color:#e6edf3;line-height:1.5;font-size:.875rem}
a{color:inherit;text-decoration:none}
/* Header */
.hdr{padding:.875rem 1.5rem;display:flex;align-items:center;gap:1rem;border-bottom:1px solid #21262d;position:sticky;top:0;background:#0d1117;z-index:10}
.logo{display:flex;align-items:center;gap:.5rem;font-weight:600;font-size:.9375rem;color:#e6edf3;flex-shrink:0}
.logo-icon{width:26px;height:26px;background:#238636;border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:.75rem;font-weight:700;color:#fff}
.hdr-sub{flex:1;color:#8b949e;font-size:.8125rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.btn-sm{background:#238636;color:#fff;border-radius:6px;padding:.375rem .875rem;font-size:.8125rem;font-weight:500;white-space:nowrap}
.btn-sm:hover{background:#2ea043}
/* Wrap */
.wrap{max-width:1100px;margin:0 auto;padding:1.5rem}
/* Biz hero */
.biz-hero{margin-bottom:1.5rem}
.back{color:#8b949e;font-size:.8125rem;display:inline-block;margin-bottom:.75rem}
.back:hover{color:#e6edf3}
.biz-name{font-size:1.75rem;font-weight:700;letter-spacing:-.02em;margin-bottom:.375rem}
.biz-meta{display:flex;gap:.75rem;align-items:center;flex-wrap:wrap}
.biz-tag{background:rgba(56,139,253,.12);border:1px solid rgba(56,139,253,.25);color:#388bfd;border-radius:20px;padding:.15rem .625rem;font-size:.75rem;font-weight:500}
.biz-loc{color:#8b949e;font-size:.8125rem}
.biz-sub{color:#8b949e;font-size:.9375rem;margin-top:.25rem;max-width:600px}
/* Compare */
.cmp{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1.5rem}
@media(max-width:700px){.cmp{grid-template-columns:1fr}}
.panel{border-radius:10px;overflow:hidden;border:1px solid #21262d;display:flex;flex-direction:column}
.panel-hd{display:flex;align-items:center;gap:.5rem;padding:.75rem 1rem;font-size:.8125rem;font-weight:600;border-bottom:1px solid #21262d;background:#161b22}
.dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.dot-r{background:#f85149}.dot-g{background:#3fb950}
.badge{margin-left:auto;font-size:.625rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:.15rem .4rem;border-radius:4px;background:rgba(63,185,80,.15);color:#3fb950;border:1px solid rgba(63,185,80,.3)}
.badge-live{animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}
.panel-before .panel-hd{color:#8b949e}
.panel-after .panel-hd{color:#e6edf3}
.panel-before{background:#161b22}
.panel-after{background:#0d1117}
.panel-bd{padding:1rem;flex:1;display:flex;flex-direction:column;gap:.75rem}
/* Content */
.raw-text{font-family:'SF Mono','Fira Code',Consolas,monospace;font-size:.75rem;color:#8b949e;line-height:1.6;white-space:pre-wrap;word-break:break-word;background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:.75rem;max-height:260px;overflow:hidden;flex:1}
.fetch-fail{color:#6e7681;font-size:.8125rem;font-style:italic;background:#161b22;border:1px solid #21262d;border-radius:6px;padding:1rem 1.125rem;flex:1;line-height:1.6}
.fetch-fail code{background:#21262d;border-radius:3px;padding:0 .25rem;font-size:.8125rem;font-style:normal;color:#a5d6ff}
.json-view{font-family:'SF Mono','Fira Code',Consolas,monospace;font-size:.75rem;color:#e6edf3;line-height:1.65;white-space:pre-wrap;word-break:break-word;background:#161b22;border:1px solid #21262d;border-radius:6px;padding:.75rem;max-height:260px;overflow-y:auto;flex:1}
.jk{color:#79c0ff}.js{color:#a5d6ff}.jb{color:#ffa657}.jn{color:#79c0ff}
.plbl{font-size:.6875rem;font-weight:500;letter-spacing:.04em}
.plbl-neg{color:#6e7681}.plbl-pos{color:#3fb950}
/* Bot sim */
.sim{background:#161b22;border:1px solid #21262d;border-radius:10px;margin-bottom:1.5rem;overflow:hidden}
.sim-hd{padding:.875rem 1rem;border-bottom:1px solid #21262d}
.sim-title{font-weight:600;font-size:.9375rem;margin-bottom:.125rem}
.sim-sub{color:#8b949e;font-size:.8125rem}
.sim-term{background:#0d1117;padding:.75rem 1rem}
.term-bar{display:flex;align-items:center;gap:.4rem;margin-bottom:.75rem;padding-bottom:.75rem;border-bottom:1px solid #21262d}
.tb-dot{width:10px;height:10px;border-radius:50%}
.tb-r{background:#f85149}.tb-y{background:#d29922}.tb-g{background:#3fb950}
.term-label{color:#484f58;font-size:.75rem;margin-left:.5rem}
.bot-row{display:flex;align-items:center;gap:.625rem;padding:.4375rem 0;font-family:'SF Mono','Fira Code',Consolas,monospace;font-size:.8125rem;transition:opacity .45s ease,transform .45s ease;opacity:0;transform:translateY(8px)}
.bt{color:#484f58;width:5.5rem;flex-shrink:0;font-size:.75rem}
.bn{color:#388bfd;font-weight:600;width:7.5rem;flex-shrink:0}
.ba{color:#30363d}
.bd{color:#8b949e;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bk{color:#3fb950;font-weight:500;white-space:nowrap}
.sim-note{font-size:.75rem;color:#484f58;padding:.75rem 1rem;border-top:1px solid #21262d;font-style:italic}
/* Stats */
.stats-ttl{font-size:.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#484f58;margin-bottom:.75rem}
.stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-bottom:1.5rem}
@media(max-width:520px){.stats-grid{grid-template-columns:1fr 1fr}}
.stat{background:#161b22;border:1px solid #21262d;border-radius:10px;padding:1rem}
.sv{font-size:1.5rem;font-weight:700;color:#e6edf3;line-height:1;margin-bottom:.25rem}
.sl{font-size:.75rem;font-weight:600;color:#8b949e;margin-bottom:.125rem}
.sh{font-size:.6875rem;color:#484f58}
/* CTA */
.cta{background:linear-gradient(135deg,#161b22 0%,#1c2128 100%);border:1px solid #30363d;border-radius:10px;padding:1.5rem;display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:1rem;flex-wrap:wrap}
.cta-copy{font-size:1rem;font-weight:500;color:#e6edf3;line-height:1.4;flex:1}
.cta-btn{background:#238636;color:#fff;border-radius:8px;padding:.625rem 1.25rem;font-size:.9375rem;font-weight:500;white-space:nowrap}
.cta-btn:hover{background:#2ea043}
/* Share */
.share{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;margin-bottom:1.5rem}
.share-url{background:#161b22;border:1px solid #21262d;border-radius:5px;padding:.25rem .5rem;font-size:.75rem;color:#8b949e;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:'SF Mono','Fira Code',Consolas,monospace}
.copy-btn{background:transparent;border:1px solid #30363d;border-radius:5px;color:#8b949e;font-size:.75rem;padding:.25rem .625rem;cursor:pointer;transition:all .15s;white-space:nowrap}
.copy-btn:hover{border-color:#8b949e;color:#e6edf3}
.try-others{color:#8b949e;font-size:.8125rem;text-align:center;padding:.75rem 0}
.try-others a{color:#388bfd}
</style>`;
}

// ── Shared fragments ───────────────────────────────────────────────────────

function hdr(subtitle: string): string {
  return `<header class="hdr">
  <a href="/demo" class="logo"><div class="logo-icon">A</div>AdvocateMCP</a>
  <div class="hdr-sub">${esc(subtitle)}</div>
  <a href="/onboard" class="btn-sm">Get Started →</a>
</header>`;
}

function ctaSection(): string {
  return `<div class="cta">
  <div class="cta-copy">Deploy this for your business — one DNS change, live in 10&nbsp;minutes.</div>
  <a href="/onboard" class="cta-btn">Get Started →</a>
</div>`;
}

// ── Landing page HTML ──────────────────────────────────────────────────────

function landingHtml(registry: RegistryEntry[], error: string | null): string {
  const chips = registry
    .map((b) => `<a href="/demo/${esc(b.slug)}" class="chip">${esc(b.name)}</a>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AdvocateMCP — AI Visibility Demo</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh;display:flex;flex-direction:column}
a{color:inherit;text-decoration:none}
.hdr{padding:1rem 1.5rem;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #21262d}
.logo{display:flex;align-items:center;gap:.5rem;font-weight:600;font-size:.9375rem}
.logo-icon{width:26px;height:26px;background:#238636;border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:.75rem;font-weight:700;color:#fff}
.nav{display:flex;gap:1.25rem;align-items:center}
.nav a{color:#8b949e;font-size:.8125rem}
.nav a:hover{color:#e6edf3}
.hero{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:3rem 1.5rem;text-align:center}
.tag{font-size:.6875rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#388bfd;background:rgba(56,139,253,.1);border:1px solid rgba(56,139,253,.2);border-radius:20px;padding:.25rem .75rem;display:inline-block;margin-bottom:1.5rem}
h1{font-size:clamp(1.75rem,5vw,3rem);font-weight:700;line-height:1.2;max-width:660px;margin-bottom:1rem;letter-spacing:-.02em;color:#e6edf3}
h1 em{font-style:normal;color:#3fb950}
.sub{font-size:1rem;color:#8b949e;max-width:500px;line-height:1.65;margin-bottom:2.5rem}
.err{background:rgba(248,81,73,.1);border:1px solid rgba(248,81,73,.3);border-radius:6px;color:#f85149;font-size:.8125rem;padding:.625rem 1rem;margin-bottom:1.25rem;max-width:520px}
.form{display:flex;gap:.5rem;width:100%;max-width:520px}
.inp{flex:1;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:.75rem 1rem;font-size:.9375rem;color:#e6edf3;outline:none;transition:border-color .15s}
.inp::placeholder{color:#484f58}
.inp:focus{border-color:#388bfd}
.sbtn{background:#238636;color:#fff;border:none;border-radius:8px;padding:.75rem 1.25rem;font-size:.9375rem;font-weight:500;cursor:pointer;white-space:nowrap}
.sbtn:hover{background:#2ea043}
.chips{display:flex;gap:.5rem;flex-wrap:wrap;justify-content:center;margin-top:.875rem}
.chip-label{color:#484f58;font-size:.75rem;line-height:2}
.chip{background:#161b22;border:1px solid #30363d;border-radius:20px;padding:.25rem .75rem;font-size:.8125rem;color:#8b949e;transition:all .15s}
.chip:hover{border-color:#388bfd;color:#e6edf3}
.how{background:#161b22;border-top:1px solid #21262d;padding:2.5rem 1.5rem}
.how-inner{max-width:780px;margin:0 auto}
.how h2{font-size:.9375rem;font-weight:600;color:#e6edf3;margin-bottom:1.25rem;text-align:center}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:1rem}
.step{background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:1rem}
.step-n{font-size:.6875rem;font-weight:700;color:#3fb950;letter-spacing:.08em;margin-bottom:.375rem}
.step-t{font-size:.875rem;font-weight:600;color:#e6edf3;margin-bottom:.25rem}
.step-d{font-size:.8125rem;color:#8b949e;line-height:1.5}
</style>
</head>
<body>
<header class="hdr">
  <div class="logo"><div class="logo-icon">A</div>AdvocateMCP</div>
  <nav class="nav">
    <a href="/status">Platform Status</a>
    <a href="/login">Client Login</a>
  </nav>
</header>
<div class="hero">
  <div class="tag">Live Demo</div>
  <h1>See what AI searches say<br>about <em>your business</em></h1>
  <p class="sub">AdvocateMCP intercepts AI crawlers before they scrape your site and returns structured, entity-dense profiles optimized for AI citation. See the difference live.</p>
  ${error === "notfound" ? `<div class="err">Business not found — try a different name or slug.</div>` : ""}
  <form class="form" action="/demo/search" method="GET">
    <input class="inp" type="text" name="q" placeholder="Enter a business name or slug…" autofocus autocomplete="off">
    <button type="submit" class="sbtn">Search →</button>
  </form>
  ${chips ? `<div class="chips"><span class="chip-label">Try:</span>${chips}</div>` : ""}
</div>
<section class="how">
  <div class="how-inner">
    <h2>How it works in 60 seconds</h2>
    <div class="steps">
      <div class="step"><div class="step-n">01 · TODAY</div><div class="step-t">AI crawler hits your site</div><div class="step-d">GPTBot, PerplexityBot, and ClaudeBot scrape raw HTML — unstructured, no entity data, low citation probability.</div></div>
      <div class="step"><div class="step-n">02 · WITH ADVOCATE</div><div class="step-t">One DNS record intercepts the crawl</div><div class="step-d">A single CNAME routes AI crawler traffic to AdvocateMCP before it reaches your site.</div></div>
      <div class="step"><div class="step-n">03 · RESULT</div><div class="step-t">Structured agent response returned</div><div class="step-d">The crawler receives entity-dense JSON — name, services, ratings, referral URL — ready for AI citation.</div></div>
    </div>
  </div>
</section>
</body>
</html>`;
}

// ── No-match page HTML ─────────────────────────────────────────────────────

function nomatchHtml(
  q: string,
  website: string | null,
  rawText: string | null,
  registry: RegistryEntry[]
): string {
  const leftContent = rawText
    ? `<pre class="raw-text">${esc(rawText)}…</pre><p class="plbl plbl-neg">✗ Unstructured &nbsp; ✗ No entity data &nbsp; ✗ Low citation probability</p>`
    : `<div class="fetch-fail">${website ? `Could not fetch <code>${esc(website)}</code> — ` : ""}The site may block automated requests. AI crawlers face the same wall.</div>`;

  const sampleData = {
    response: `This is what an AdvocateMCP agent response would look like for ${q}. Structured, entity-dense data — services, ratings, location, contact, and a tracked referral URL — returned directly to the AI crawler.`,
    business: q,
    intent: "brand_direct",
    referral_url: website ?? "https://example.com/contact",
    powered_by: "AdvocateMCP",
  };

  const tryLinks = registry
    .slice(0, 3)
    .map((b) => `<a href="/demo/${esc(b.slug)}">${esc(b.name)}</a>`)
    .join(" · ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AdvocateMCP Demo — ${esc(q)}</title>
${demoStyles()}
</head>
<body>
${hdr("Not registered yet")}
<div class="wrap">
  <div class="biz-hero">
    <a href="/demo" class="back">← Search</a>
    <div class="biz-name">${esc(q)}</div>
    <div class="biz-sub">This business isn't on AdvocateMCP yet — here's what their AI profile could look like</div>
  </div>
  <div class="cmp">
    <div class="panel panel-before">
      <div class="panel-hd"><span class="dot dot-r"></span>What AI crawlers see today</div>
      <div class="panel-bd">${leftContent}</div>
    </div>
    <div class="panel panel-after">
      <div class="panel-hd"><span class="dot dot-g"></span>With AdvocateMCP <span class="badge">Example</span></div>
      <div class="panel-bd">
        <pre class="json-view">${syntaxHighlight(JSON.stringify(sampleData, null, 2))}</pre>
        <p class="plbl plbl-pos">✓ Structured &nbsp; ✓ Entity-dense &nbsp; ✓ Optimized for AI retrieval</p>
      </div>
    </div>
  </div>
  ${tryLinks ? `<div class="try-others">See live examples: ${tryLinks}</div>` : ""}
  ${ctaSection()}
</div>
</body>
</html>`;
}

// ── Result page HTML ───────────────────────────────────────────────────────

function resultHtml(
  slug: string,
  profile: Profile,
  displayData: Record<string, unknown>,
  hasRealData: boolean,
  rawText: string | null,
  analytics: GlobalAnalytics | null
): string {
  const domain = profile.website
    ? (() => { try { return new URL(profile.website).hostname.replace(/^www\./, ""); } catch { return slug; } })()
    : slug;

  const leftContent = rawText
    ? `<pre class="raw-text">${esc(rawText)}…</pre><p class="plbl plbl-neg">✗ Unstructured &nbsp; ✗ No entity data &nbsp; ✗ Low citation probability</p>`
    : `<div class="fetch-fail">Could not fetch <code>${esc(domain)}</code> — the site may block automated requests. AI crawlers hit the same wall.</div>`;

  const jsonStr =
    Object.keys(displayData).length > 0
      ? JSON.stringify(displayData, null, 2)
      : `{ "error": "Agent response unavailable — check Railway logs" }`;

  const topBot = analytics
    ? Object.entries(analytics.queries_by_crawler)
        .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    : null;

  const now = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  const bots = ["GPTBot", "PerplexityBot", "ClaudeBot"] as const;
  const botRows = bots
    .map(
      (bot, i) => `<div class="bot-row" data-delay="${i * 600}">
      <span class="bt">${esc(now)}</span>
      <span class="bn">${esc(bot)}</span>
      <span class="ba">→</span>
      <span class="bd">requesting ${esc(domain)}</span>
      <span class="ba">→</span>
      <span class="bk">received structured response ✓</span>
    </div>`
    )
    .join("");

  const stats = [
    { v: analytics ? analytics.total_queries.toLocaleString() : "—", l: "Total AI Requests", h: "Platform-wide" },
    { v: topBot ?? "—", l: "Most Active Bot", h: analytics ? "Highest volume" : "No data yet" },
    { v: analytics ? analytics.total_referral_clicks.toLocaleString() : "—", l: "Referral Clicks", h: "Human clicks from AI citations" },
  ];

  const statsHtml = stats
    .map((s) => `<div class="stat"><div class="sv">${esc(s.v)}</div><div class="sl">${esc(s.l)}</div><div class="sh">${esc(s.h)}</div></div>`)
    .join("");

  const shareUrl = `https://advocatemcp-worker.advocatecameron.workers.dev/demo/${slug}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Visibility Demo — ${esc(profile.name)}</title>
<meta property="og:title" content="AI Visibility Demo — ${esc(profile.name)}">
<meta property="og:description" content="See exactly what GPTBot, PerplexityBot &amp; ClaudeBot receive when they query ${esc(profile.name)}.">
${demoStyles()}
</head>
<body>
${hdr(`${profile.name} — AI Visibility Demo`)}
<div class="wrap">

  <!-- Hero -->
  <div class="biz-hero">
    <a href="/demo" class="back">← Search</a>
    <div class="biz-name">${esc(profile.name)}</div>
    <div class="biz-meta">
      ${profile.category ? `<span class="biz-tag">${esc(profile.category)}</span>` : ""}
      ${profile.location ? `<span class="biz-loc">📍 ${esc(profile.location)}</span>` : ""}
    </div>
  </div>

  <!-- Side-by-side comparison -->
  <div class="cmp">
    <div class="panel panel-before">
      <div class="panel-hd">
        <span class="dot dot-r"></span>What AI crawlers see today
      </div>
      <div class="panel-bd">${leftContent}</div>
    </div>
    <div class="panel panel-after">
      <div class="panel-hd">
        <span class="dot dot-g"></span>What AI crawlers see with AdvocateMCP
        <span class="badge">Preview</span>
      </div>
      <div class="panel-bd">
        <pre class="json-view">${syntaxHighlight(jsonStr)}</pre>
        <p class="plbl plbl-pos">✓ Structured &nbsp; ✓ Entity-dense &nbsp; ✓ Optimized for AI retrieval</p>
      </div>
    </div>
  </div>

  <!-- Bot simulation -->
  <div class="sim">
    <div class="sim-hd">
      <div class="sim-title">Bot Simulation</div>
      <div class="sim-sub">Watch each AI crawler receive the structured response in real time</div>
    </div>
    <div class="sim-term">
      <div class="term-bar">
        <span class="tb-dot tb-r"></span><span class="tb-dot tb-y"></span><span class="tb-dot tb-g"></span>
        <span class="term-label">simulated preview — deploy to go live</span>
      </div>
      ${botRows}
    </div>
    <p class="sim-note">This is a preview of what AI crawlers will receive once AdvocateMCP is deployed on ${esc(domain)}</p>
  </div>

  <!-- Stats -->
  <div class="stats-ttl">Platform Stats</div>
  <div class="stats-grid">${statsHtml}</div>

  <!-- CTA -->
  ${ctaSection()}

  <!-- Share -->
  <div class="share">
    <span style="color:#484f58;font-size:.8125rem;white-space:nowrap">Share this demo:</span>
    <code class="share-url">${esc(shareUrl)}</code>
    <button class="copy-btn" onclick="navigator.clipboard.writeText(${JSON.stringify(shareUrl)}).then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',2000)})">Copy</button>
  </div>
</div>

<script>
(function(){
  var rows=document.querySelectorAll('.bot-row');
  rows.forEach(function(r){
    var d=parseInt(r.getAttribute('data-delay')||'0',10);
    setTimeout(function(){r.style.opacity='1';r.style.transform='translateY(0)';},400+d);
  });
})();
</script>
</body>
</html>`;
}

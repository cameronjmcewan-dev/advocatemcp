// ⚠️ SINGLE SOURCE OF TRUTH for design tokens, header chrome, and footer.
// DO NOT duplicate color values, header HTML, or theme logic in any other file.
// DO NOT add new routes that render their own <style> block with hardcoded hex colors.
// Any new page handler MUST import BASE_TOKENS_CSS + BASE_LAYOUT_CSS + renderHeader().
//
// When adding a new page:
//   1. import { BASE_TOKENS_CSS, BASE_LAYOUT_CSS, renderHeader, renderFooter, themeToggleScript } from "./sharedLayout";
//   2. Inside <head>: ${BASE_TOKENS_CSS}${BASE_LAYOUT_CSS}<style>${pageSpecificStyles}</style>
//   3. Inside <body>: ${renderHeader({...})} ... ${renderFooter()} ${themeToggleScript()}
//   4. Use var(--bg), var(--text), var(--green), etc. — never hardcoded hex in pageSpecificStyles.

// ── CSS custom properties (dark default + html.light override) ───────────────
// This is the authoritative palette for the entire app. Any new color must be
// added here first, then referenced via var(--name) in page-specific styles.

export const BASE_TOKENS_CSS = `<style>
:root{
  --bg:#0d1117;--bg2:#161b22;--bg3:#1c2128;--card:#161b22;
  --text:#e6edf3;--sub:#8b949e;--muted:#484f58;
  --border:#21262d;--border2:#30363d;
  --green:#238636;--green2:#2ea043;--green3:#3fb950;
  --blue:#388bfd;--blue-bg:rgba(56,139,253,.12);--blue-border:rgba(56,139,253,.25);
  --red:#f85149;--yellow:#d29922;--orange:#ffa657;
  --font:'Poppins',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  --mono:'SF Mono','Fira Code',Consolas,monospace;
}
html.light{
  --bg:#f9fafb;--bg2:#fff;--bg3:#f3f4f6;--card:#fff;
  --text:#111827;--sub:#6b7280;--muted:#9ca3af;
  --border:#e5e7eb;--border2:#d1d5db;
  --green:#16a34a;--green2:#15803d;--green3:#059669;
  --blue:#2563eb;--blue-bg:rgba(37,99,235,.08);--blue-border:rgba(37,99,235,.2);
  --red:#dc2626;--yellow:#d97706;--orange:#ea580c;
}
</style>`;

// ── Base layout CSS shared by every page ─────────────────────────────────────
// Resets + body + header chrome + buttons + footer. All rules use var(--...).
// Page-specific layout classes (.wrap, .hero, .panel, .step, etc.) go in the
// individual page file.

export const BASE_LAYOUT_CSS = `<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font-family:var(--font);background:var(--bg);color:var(--text);line-height:1.5;font-size:.875rem;min-height:100vh;display:flex;flex-direction:column;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}

/* ── Header (unified) ── */
.hdr{padding:.875rem 1.5rem;display:flex;align-items:center;gap:1rem;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--bg);z-index:10}
.logo{display:flex;align-items:center;gap:.5rem;font-weight:600;font-size:.9375rem;color:var(--text);flex-shrink:0}
.logo-icon{width:26px;height:26px;background:var(--green);border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:.75rem;font-weight:700;color:#fff}
.hdr-sub{flex:1;color:var(--sub);font-size:.8125rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hdr-nav{display:flex;gap:1rem;align-items:center;flex-shrink:0}
.hdr-nav a{color:var(--sub);font-size:.8125rem;transition:color .15s}
.hdr-nav a:hover{color:var(--text)}
.hdr-nav a.active{color:var(--text);font-weight:500}
.theme-btn{background:none;border:1px solid var(--border2);border-radius:6px;color:var(--sub);font-size:.75rem;padding:.25rem .5rem;cursor:pointer;transition:all .15s;font-family:inherit}
.theme-btn:hover{border-color:var(--sub);color:var(--text)}

/* ── Shared buttons ── */
.btn-sm{background:var(--green);color:#fff;border-radius:6px;padding:.375rem .875rem;font-size:.8125rem;font-weight:500;white-space:nowrap;transition:background .15s;border:none;cursor:pointer;font-family:inherit}
.btn-sm:hover{background:var(--green2)}
.btn-primary{background:var(--green);color:#fff;border:none;border-radius:8px;padding:.75rem 1.5rem;font-size:.9375rem;font-weight:500;cursor:pointer;transition:background .15s;font-family:inherit}
.btn-primary:hover{background:var(--green2)}

/* ── Footer ── */
.footer{border-top:1px solid var(--border);padding:1rem 1.5rem;text-align:center;color:var(--muted);font-size:.75rem;background:var(--bg)}
.footer a{color:var(--sub);margin:0 .375rem;transition:color .15s}
.footer a:hover{color:var(--text)}

/* ── Mobile ── */
@media(max-width:520px){
  .hdr{padding:.75rem 1rem;gap:.5rem}
  .hdr-sub{display:none}
  .hdr-nav{gap:.625rem}
  .hdr-nav a{font-size:.75rem}
}
</style>`;

// ── Header renderer ──────────────────────────────────────────────────────────

export interface HeaderOptions {
  /** Subtitle text shown between logo and nav (optional) */
  subtitle?: string;
  /** Show the "Get Started →" CTA button on the right edge (defaults to false) */
  showCta?: boolean;
  /** Which nav item to highlight */
  activeNav?: "demo" | "status" | "login" | null;
}

function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function googleFontsLink(): string {
  return `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">`;
}

export function renderHeader(opts: HeaderOptions = {}): string {
  const { subtitle, showCta = false, activeNav = null } = opts;
  const subHtml = subtitle ? `<div class="hdr-sub">${escAttr(subtitle)}</div>` : `<div class="hdr-sub"></div>`;
  const cls = (name: string) => (activeNav === name ? ' class="active"' : "");
  const cta = showCta ? `<a href="/onboard" class="btn-sm">Get Started →</a>` : "";
  return `<header class="hdr">
  <a href="/demo" class="logo"><div class="logo-icon">A</div>AdvocateMCP</a>
  ${subHtml}
  <nav class="hdr-nav">
    <a href="/demo"${cls("demo")}>Demo</a>
    <a href="/status"${cls("status")}>Status</a>
    <a href="/login"${cls("login")}>Login</a>
    <button type="button" id="theme-toggle" class="theme-btn" aria-label="Toggle theme">◐</button>
    ${cta}
  </nav>
</header>`;
}

// ── Footer renderer ──────────────────────────────────────────────────────────

export function renderFooter(): string {
  return `<footer class="footer">
  AdvocateMCP &mdash; AI Visibility for Local Businesses
  &middot; <a href="/status">Status</a>
  &middot; <a href="/demo">Demo</a>
  &middot; <a href="/login">Login</a>
</footer>`;
}

// ── Theme toggle script ──────────────────────────────────────────────────────
// Reads localStorage "amcp_theme", applies html.light, wires up #theme-toggle.
// Idempotent — safe to include on any page that renders the shared header.

export function themeToggleScript(): string {
  return `<script>
(function(){
  var KEY='amcp_theme';
  var saved=null;
  try{saved=localStorage.getItem(KEY);}catch(e){}
  var prefersLight=false;
  try{prefersLight=window.matchMedia('(prefers-color-scheme:light)').matches;}catch(e){}
  if(saved==='light'||(!saved&&prefersLight)){document.documentElement.classList.add('light');}
  function wire(){
    var btn=document.getElementById('theme-toggle');
    if(!btn)return;
    btn.addEventListener('click',function(){
      var isLight=document.documentElement.classList.toggle('light');
      try{localStorage.setItem(KEY,isLight?'light':'dark');}catch(e){}
    });
  }
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',wire);}else{wire();}
})();
</script>`;
}

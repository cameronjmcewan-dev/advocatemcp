/* Per-provider DNS setup guides for the activate page.
 *
 * Each guide is data-only — the activate-page renderer reads from
 * window.AMCP_DNS_GUIDES[providerId] and lays out steps + tips. Keeping
 * this as data (not HTML strings with embedded layout) means the
 * activate page can re-skin guidance without editing every guide.
 *
 * Guide shape:
 *   {
 *     name:           "GoDaddy",
 *     login_url:      "https://dcc.godaddy.com/control/dnsmanagement",
 *     apex_strategy:  "anaame|forwarding|cf-nameservers|a-records|managed",
 *     apex_steps:     [...],     // ordered steps for apex routing
 *     www_steps:      [...],     // ordered steps for www CNAME
 *     txt_steps:      [...],     // ordered steps for adding the DCV/ownership TXT records
 *     gotchas:        [...],     // 1-2 line warnings specific to this provider
 *     auto_dns:       false,     // set true once Phase D programmatic-DNS lands for this provider
 *   }
 *
 * Step shape:
 *   { type: "do" | "tip" | "warning", text: "..." }
 *
 * The activate page interpolates {{record_host}} and {{record_value}}
 * placeholders in step text against the actual records the customer
 * needs to add. Keep placeholders to the small set:
 *   {{apex}}        — bare apex domain (acme.com)
 *   {{www}}         — www variant (www.acme.com)
 *   {{cname_target}}— customers.advocatemcp.com
 *   {{txt_host}}    — _cf-custom-hostname.acme.com
 *   {{txt_value}}   — the DCV value
 */

(function () {
  'use strict';

  var GUIDES = {

    // ── GoDaddy ─────────────────────────────────────────────────────────────
    godaddy: {
      name: "GoDaddy",
      login_url: "https://dcc.godaddy.com/control/dnsmanagement",
      apex_strategy: "forwarding",
      auto_dns: true,
      www_steps: [
        { type: "do",  text: "Sign in at godaddy.com." },
        { type: "do",  text: "Click the avatar in the top right → 'My Products'." },
        { type: "do",  text: "Find your domain in the list, click 'DNS' next to it." },
        { type: "do",  text: "Scroll to the Records section, click 'Add'." },
        { type: "do",  text: "Type: CNAME. Name: www. Value: {{cname_target}}. TTL: 1 hour. Save." },
      ],
      apex_steps: [
        { type: "tip", text: "GoDaddy doesn't natively support ANAME / ALIAS, so we use Domain Forwarding to redirect apex traffic to www. Bots follow the redirect to the optimized response — same outcome as a true ANAME record." },
        { type: "do",  text: "From your domain's overview page, click the 'Forwarding' section." },
        { type: "do",  text: "Click 'Add Forwarding'." },
        { type: "do",  text: "Forward to: https://{{www}}. Forward type: Permanent (301). Settings: Forward only (NOT 'Update my nameservers and DNS')." },
        { type: "do",  text: "Save." },
        { type: "warning", text: "Do NOT pick 'Update my nameservers' — that breaks the rest of your DNS records you just added." },
      ],
      txt_steps: [
        { type: "do",  text: "Back in the DNS Management page, click 'Add' under Records again." },
        { type: "do",  text: "Type: TXT. Name: {{txt_host_name}}. Value: {{txt_value}}. TTL: 1 hour. Save." },
        { type: "tip", text: "GoDaddy will append .yourdomain.com automatically — paste only the part before the dot." },
      ],
      gotchas: [
        "If you ever moved your DNS off GoDaddy, the records won't apply. Check 'Nameservers' on your domain overview — they should be ns##.domaincontrol.com.",
        "GoDaddy caches TTLs aggressively. Allow up to 1 hour for propagation even if you set TTL to 600.",
      ],
    },

    // ── Squarespace ─────────────────────────────────────────────────────────
    squarespace: {
      name: "Squarespace",
      login_url: "https://account.squarespace.com/domains",
      apex_strategy: "cf-nameservers",
      auto_dns: false,
      www_steps: [
        { type: "do",  text: "Sign in at squarespace.com." },
        { type: "do",  text: "Open Settings → Domains. Click your domain." },
        { type: "do",  text: "Click 'DNS Settings' (or 'Custom DNS' on older accounts)." },
        { type: "do",  text: "Click 'Add Record'. Type: CNAME. Host: www. Data: {{cname_target}}. Save." },
      ],
      apex_steps: [
        { type: "tip", text: "Squarespace's built-in DNS doesn't support ANAME / ALIAS. The cleanest path is to move DNS to Cloudflare (free, 10 min) — that gives you proper apex CNAME flattening AND a free CDN on top." },
        { type: "do",  text: "Sign up at cloudflare.com (free plan)." },
        { type: "do",  text: "Click 'Add a site', enter {{apex}}, pick the Free plan." },
        { type: "do",  text: "Cloudflare scans your existing DNS records — review them, click 'Continue'. They migrate over so your site stays working." },
        { type: "do",  text: "Cloudflare gives you 2 nameservers (e.g., lola.ns.cloudflare.com)." },
        { type: "do",  text: "Back in Squarespace → Domains → 'Advanced settings' → 'Use Custom Nameservers'. Paste both Cloudflare nameservers. Save." },
        { type: "do",  text: "Wait ~10 min - 24h for the nameserver change to propagate. Re-run AdvocateMCP setup — we'll detect you're on Cloudflare and add records automatically (no manual apex setup needed)." },
        { type: "warning", text: "Switching to Cloudflare nameservers does NOT affect your Squarespace site — your site keeps working. It only changes who answers DNS queries." },
      ],
      txt_steps: [
        { type: "do",  text: "In Squarespace's DNS panel: Add Record. Type: TXT. Host: {{txt_host_name}}. Data: {{txt_value}}. Save." },
        { type: "tip", text: "If you moved DNS to Cloudflare per the apex steps above, add the TXT record in Cloudflare's DNS panel instead." },
      ],
      gotchas: [
        "Squarespace's DNS panel sometimes hides the apex record (@) from new accounts. If you don't see it, contact Squarespace support OR switch to Cloudflare nameservers — easier than fighting their UI.",
      ],
    },

    // ── Namecheap ───────────────────────────────────────────────────────────
    namecheap: {
      name: "Namecheap",
      login_url: "https://ap.www.namecheap.com/domains/list/",
      apex_strategy: "alias",
      auto_dns: true,
      www_steps: [
        { type: "do",  text: "Sign in at namecheap.com." },
        { type: "do",  text: "Domain List → 'Manage' next to your domain → 'Advanced DNS' tab." },
        { type: "do",  text: "Click 'Add New Record'. Type: CNAME Record. Host: www. Value: {{cname_target}}. TTL: Automatic. Save." },
      ],
      apex_steps: [
        { type: "tip", text: "Namecheap supports an 'ALIAS Record' on their FreeDNS / BasicDNS that works at the apex — that's the cleanest path." },
        { type: "do",  text: "In Advanced DNS → 'Add New Record'." },
        { type: "do",  text: "Type: ALIAS Record. Host: @. Value: {{cname_target}}. TTL: Automatic. Save." },
        { type: "warning", text: "If 'ALIAS Record' isn't an option in your dropdown, you're on PremiumDNS or a third-party DNS. In that case, fall back to URL Redirect (Type: URL Redirect Record, Host: @, Value: https://{{www}}, Type: Permanent (301))." },
      ],
      txt_steps: [
        { type: "do",  text: "In Advanced DNS → 'Add New Record'." },
        { type: "do",  text: "Type: TXT Record. Host: {{txt_host_name}}. Value: {{txt_value}}. TTL: Automatic. Save." },
      ],
      gotchas: [
        "Namecheap requires Email Forwarding to be set up before you can add MX records. Doesn't affect us, but if you see surprising MX warnings, that's why.",
      ],
    },

    // ── Cloudflare ──────────────────────────────────────────────────────────
    cloudflare: {
      name: "Cloudflare",
      login_url: "https://dash.cloudflare.com/",
      apex_strategy: "managed",
      auto_dns: true, // Phase D will plug in token-based auto-DNS for this provider first.
      www_steps: [
        { type: "do",  text: "Sign in at dash.cloudflare.com." },
        { type: "do",  text: "Pick your domain → DNS → Records." },
        { type: "do",  text: "Click 'Add record'. Type: CNAME. Name: www. Target: {{cname_target}}. Proxy status: DNS only (gray cloud). Save." },
      ],
      apex_steps: [
        { type: "tip", text: "Cloudflare's CNAME flattening works at the apex — you can CNAME the root of your zone directly to {{cname_target}}, no ANAME needed." },
        { type: "do",  text: "Click 'Add record'. Type: CNAME. Name: @ (or your bare domain). Target: {{cname_target}}. Proxy status: DNS only (gray cloud). Save." },
        { type: "warning", text: "Keep proxy status set to 'DNS only' (gray cloud), not 'Proxied' (orange cloud) — Cloudflare-proxied traffic conflicts with our SaaS routing on the same edge." },
      ],
      txt_steps: [
        { type: "do",  text: "Click 'Add record'. Type: TXT. Name: {{txt_host_name}}. Content: {{txt_value}}. TTL: Auto. Save." },
      ],
      gotchas: [
        "If you use Cloudflare for everything (DNS + CDN + email), be careful not to enable proxy on the records pointing at AdvocateMCP — that double-proxies and produces weird headers.",
      ],
    },

    // ── Wix ─────────────────────────────────────────────────────────────────
    wix: {
      name: "Wix",
      login_url: "https://www.wix.com/my-account/",
      apex_strategy: "wix-pointing",
      auto_dns: false,
      www_steps: [
        { type: "do",  text: "Sign in at wix.com." },
        { type: "do",  text: "Domains → click your domain → Advanced → DNS Records." },
        { type: "do",  text: "Add a CNAME record. Host name: www. Points to: {{cname_target}}. Save." },
      ],
      apex_steps: [
        { type: "tip", text: "Wix has limited apex support and doesn't expose ANAME / ALIAS. The cleanest path is to switch DNS to Cloudflare (free) so we can use CNAME flattening at the apex — same approach as Squarespace." },
        { type: "do",  text: "Sign up at cloudflare.com (free plan), add {{apex}} as a site." },
        { type: "do",  text: "Cloudflare scans your existing DNS, pre-populates records, gives you 2 nameservers." },
        { type: "do",  text: "Back in Wix → Domains → your domain → Advanced → 'Change Name Servers'. Paste the Cloudflare nameservers. Save." },
        { type: "do",  text: "Wait 10 min - 24h for propagation. Re-run AdvocateMCP setup — we'll detect Cloudflare and add records automatically with no manual apex work." },
      ],
      txt_steps: [
        { type: "do",  text: "In Wix DNS Records (or Cloudflare's DNS panel if you switched): add a TXT record. Host name: {{txt_host_name}}. Value: {{txt_value}}. Save." },
      ],
      gotchas: [
        "Wix requires you to be on a paid Wix plan to manage DNS records on a domain registered through them.",
      ],
    },

    // ── Google Domains (deprecated; some customers still mid-migration) ────
    "google-domains": {
      name: "Google Domains",
      login_url: "https://domains.google.com/registrar/",
      apex_strategy: "managed",
      auto_dns: false,
      www_steps: [
        { type: "warning", text: "Google Domains was sold to Squarespace in 2023. If you're still on Google's interface, your domain is being migrated — you may want to follow the Squarespace guide instead." },
        { type: "do",  text: "Sign in at domains.google.com (if still active for your account)." },
        { type: "do",  text: "Click your domain → DNS → 'Manage custom records'." },
        { type: "do",  text: "Add: Host: www. Type: CNAME. TTL: 1H. Data: {{cname_target}}. Save." },
      ],
      apex_steps: [
        { type: "do",  text: "In 'Manage custom records', add a synthetic record at @ pointing to {{cname_target}}." },
        { type: "tip", text: "Google Domains' Cloud DNS supported ANAME-equivalent A-record synthesis. After migration to Squarespace, this stops working — switch to the Squarespace guide once you see the new UI." },
        { type: "tip", text: "Better long-term: move DNS to Cloudflare. Sign up at cloudflare.com (free), add {{apex}}, copy the 2 nameservers, swap them in at Google Domains. Re-run AdvocateMCP setup once propagated — we'll auto-add records." },
      ],
      txt_steps: [
        { type: "do",  text: "Add a custom record. Host: {{txt_host_name}}. Type: TXT. TTL: 1H. Data: {{txt_value}}. Save." },
      ],
      gotchas: [
        "If your Google Domains UI redirects you to a Squarespace login, your domain has been migrated. Switch to the Squarespace guide.",
      ],
    },

    // ── AWS Route 53 ────────────────────────────────────────────────────────
    route53: {
      name: "AWS Route 53",
      login_url: "https://console.aws.amazon.com/route53/v2/hostedzones",
      apex_strategy: "alias",
      auto_dns: true,
      www_steps: [
        { type: "do",  text: "Sign in to AWS Console → Route 53 → Hosted zones." },
        { type: "do",  text: "Click your hosted zone → 'Create record'." },
        { type: "do",  text: "Record name: www. Record type: CNAME. Value: {{cname_target}}. TTL: 300. Save." },
      ],
      apex_steps: [
        { type: "tip", text: "Route 53 has native ALIAS records that work at the apex. Use ALIAS, not A or CNAME, at the root." },
        { type: "do",  text: "Click 'Create record'. Record name: leave empty (apex). Record type: A. 'Alias' toggle: ON. Route traffic to: 'Alias to another record'. Region: pick the closest. Type {{cname_target}} into the alias target. Save." },
        { type: "warning", text: "If the ALIAS dropdown doesn't accept {{cname_target}} directly (Route 53 typically wants ALB/CloudFront/S3 endpoints), fall back to a static A record using the IPs we list under 'Other DNS providers' — or contact us for the current values." },
      ],
      txt_steps: [
        { type: "do",  text: "Click 'Create record'. Record name: {{txt_host_name}}. Record type: TXT. Value: {{txt_value}} (wrap in double-quotes). TTL: 300. Save." },
      ],
      gotchas: [
        "Route 53 charges per hosted zone (~$0.50/month). If the cost annoys you, switching to Cloudflare DNS (free) is straightforward — point your domain registrar at Cloudflare's nameservers.",
      ],
    },

    // ── Shopify ─────────────────────────────────────────────────────────────
    shopify: {
      name: "Shopify",
      login_url: "https://www.shopify.com/admin/settings/domains",
      apex_strategy: "cf-nameservers",
      auto_dns: false,
      www_steps: [
        { type: "tip", text: "Shopify's DNS panel doesn't expose enough record types for AdvocateMCP setup. The cleanest fix is to move your domain's DNS to Cloudflare (free), keep Shopify as your store host, and we'll add records via Cloudflare automatically afterward." },
        { type: "do",  text: "Sign up at cloudflare.com (free plan)." },
        { type: "do",  text: "Click 'Add a site', enter {{apex}}, pick the Free plan." },
        { type: "do",  text: "Cloudflare scans your existing DNS and pre-populates the records — review them, click 'Continue'." },
        { type: "do",  text: "Cloudflare gives you 2 nameservers (e.g., lola.ns.cloudflare.com)." },
        { type: "do",  text: "In your domain registrar (NOT Shopify — wherever you actually bought the domain), change the nameservers to Cloudflare's two values." },
        { type: "do",  text: "Wait ~10 min - 24h for nameservers to propagate. Then re-run AdvocateMCP setup. We'll detect Cloudflare and add records automatically." },
      ],
      apex_steps: [
        { type: "tip", text: "After Cloudflare migration above, our auto-DNS handles apex via CNAME flattening — no extra step on your end." },
      ],
      txt_steps: [
        { type: "tip", text: "After Cloudflare migration, our auto-DNS adds the SSL TXT record automatically." },
      ],
      gotchas: [
        "Switching nameservers does NOT take down your Shopify store — it stays on Shopify, you just change who answers DNS queries about your domain.",
      ],
    },

    // ── HostGator (EIG / Newfold) ───────────────────────────────────────────
    hostgator: {
      name: "HostGator",
      login_url: "https://portal.hostgator.com/customer/login.php",
      apex_strategy: "cf-nameservers",
      auto_dns: false,
      www_steps: [
        { type: "tip", text: "HostGator manages DNS via cPanel and doesn't expose a public API. Cleanest path: move DNS to Cloudflare (free), keep HostGator as your hosting." },
        { type: "do",  text: "Sign up at cloudflare.com (free), add {{apex}}, copy the 2 Cloudflare nameservers." },
        { type: "do",  text: "Sign in at portal.hostgator.com → My Domains → click your domain → Nameservers → 'Change Nameservers'." },
        { type: "do",  text: "Replace HostGator's nameservers with the Cloudflare ones. Save." },
        { type: "do",  text: "Wait ~10 min - 24h for propagation. Re-run AdvocateMCP setup; we'll detect Cloudflare and finish automatically." },
      ],
      apex_steps: [
        { type: "tip", text: "Cloudflare flattening at apex handles routing once you complete the migration above." },
      ],
      txt_steps: [
        { type: "tip", text: "We add the SSL TXT record via the Cloudflare auto-DNS flow after migration." },
      ],
      gotchas: [
        "HostGator's DNS UI sometimes lives under 'cPanel → Zone Editor' and sometimes under 'My Domains → DNS' depending on plan tier. The Cloudflare migration sidesteps that variance.",
      ],
    },

    // ── Bluehost (EIG / Newfold) ────────────────────────────────────────────
    bluehost: {
      name: "Bluehost",
      login_url: "https://my.bluehost.com/cgi/login",
      apex_strategy: "cf-nameservers",
      auto_dns: false,
      www_steps: [
        { type: "tip", text: "Bluehost manages DNS via their cPanel-based panel and doesn't expose a public API. Move DNS to Cloudflare (free) for the cleanest setup." },
        { type: "do",  text: "Sign up at cloudflare.com (free), add {{apex}}, copy the 2 Cloudflare nameservers." },
        { type: "do",  text: "Sign in at my.bluehost.com → Domains → click your domain → Name Servers." },
        { type: "do",  text: "Pick 'Use Custom Nameservers'. Paste the Cloudflare ones. Save." },
        { type: "do",  text: "Wait ~10 min - 24h. Re-run AdvocateMCP setup; we'll detect Cloudflare and finish." },
      ],
      apex_steps: [
        { type: "tip", text: "Cloudflare flattening handles apex once you've completed the migration above." },
      ],
      txt_steps: [
        { type: "tip", text: "Auto-handled by our Cloudflare auto-DNS flow after migration." },
      ],
      gotchas: [
        "Like other Newfold-owned hosts (HostGator, Domain.com, Network Solutions), Bluehost's DNS UI is dated and inconsistent. Cloudflare's modern UI handles everything once you switch.",
      ],
    },

    // ── IONOS (1&1) ─────────────────────────────────────────────────────────
    ionos: {
      name: "IONOS",
      login_url: "https://my.ionos.com/dns",
      apex_strategy: "a-records",
      auto_dns: true,
      www_steps: [
        { type: "do",  text: "Sign in at my.ionos.com." },
        { type: "do",  text: "Domains & SSL → click your domain → DNS." },
        { type: "do",  text: "Click 'Add record'. Type: CNAME. Host name: www. Points to: {{cname_target}}. TTL: 3600. Save." },
      ],
      apex_steps: [
        { type: "tip", text: "IONOS DNS doesn't support ANAME at apex, so we route apex via static A records pointing at our anycast IPs." },
        { type: "do",  text: "Click 'Add record'. Type: A. Host name: @ (or leave empty). Value: 104.21.44.57. Save. Repeat for 172.67.195.220." },
        { type: "warning", text: "Static A records work today but Cloudflare anycast IPs can rotate. Re-check this guide every few months." },
      ],
      txt_steps: [
        { type: "do",  text: "Click 'Add record'. Type: TXT. Host name: {{txt_host_name}}. Content: {{txt_value}}. TTL: 3600. Save." },
      ],
      gotchas: [
        "IONOS sometimes shows DNS records under 'Settings → DNS' rather than at the top level. If you don't see DNS listed, dig deeper into the domain's settings panel.",
      ],
    },

    // ── Generic fallback ────────────────────────────────────────────────────
    other: {
      name: "your DNS provider",
      login_url: null,
      apex_strategy: "generic",
      auto_dns: false,
      www_steps: [
        { type: "do",  text: "Sign in to your DNS provider's control panel (the place where you bought your domain, or wherever you've moved DNS to since)." },
        { type: "do",  text: "Find the section labeled DNS, DNS Zone, or Records — every provider names it slightly differently." },
        { type: "do",  text: "Add a CNAME record. Name: www. Value (or 'Points to'): {{cname_target}}. TTL: leave default or set to 1 hour. Save." },
      ],
      apex_steps: [
        { type: "tip", text: "DNS doesn't allow CNAME at the zone apex (the root of your domain, with no www). So apex needs special handling. In rough order of preference:" },
        { type: "do",  text: "Option 1 — ANAME / ALIAS / CNAME-flattening: if your DNS provider supports any of these record types, add one at @ (apex) pointing to {{cname_target}}. Cleanest." },
        { type: "do",  text: "Option 2 — Domain forwarding: if your provider has a 'Domain Forwarding' or 'URL Redirect' feature, set apex → https://{{www}} as a Permanent (301) redirect. AI bots follow the redirect to the www variant which goes through us." },
        { type: "do",  text: "Option 3 — Cloudflare nameservers: sign up at cloudflare.com (free), add your domain, switch your registrar's nameservers to Cloudflare's. Inside Cloudflare, you get apex CNAME flattening for free." },
        { type: "do",  text: "Option 4 — Static A records: in your DNS panel, add two A records at @ (apex) pointing to 104.21.44.57 and 172.67.195.220. These are the same anycast IPs that {{cname_target}} resolves to, so apex traffic lands on our edge the same way www does." },
        { type: "warning", text: "Static A records work today but Cloudflare anycast IPs can rotate. Re-check this guide every few months, or use options 1-3 for long-term stability." },
      ],
      txt_steps: [
        { type: "do",  text: "Add a TXT record. Host / Name: {{txt_host_name}}. Value: {{txt_value}}. TTL: default. Save." },
        { type: "tip", text: "Some providers expect the host with a trailing dot (e.g. _cf-custom-hostname.acme.com.) — if your provider rejects the value, try with and without the trailing dot." },
      ],
      gotchas: [
        "If you don't know who manages your DNS, run `dig NS yourdomain.com` (or visit https://www.whatsmydns.net) and look at the NS records. The hostname tells you the provider — e.g. ns1.googledomains.com → Google, ns35.domaincontrol.com → GoDaddy.",
        "Tell us your provider so we can add a guide. Email max@advocate-mcp.com — usually only takes us a day to add new providers.",
      ],
    },
  };

  window.AMCP_DNS_GUIDES = GUIDES;
})();

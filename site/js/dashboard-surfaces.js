/* AI Surfaces section, shows every AI platform the tenant's agent is
 * syndicated onto (some live, some pending directory submission), and
 * provides a copy-paste schema.org JSON-LD block for their website `<head>`
 * so Google SGE / Bing Copilot can ingest their profile.
 *
 * Data sources:
 *   - window.AMCP_DATA (slug, plan, is_hosted, domain) set by dashboard.html
 *   - GET api.advocatemcp.com/agents/:slug/json-ld.json for the snippet
 *   - GET /api/client/radar (proxied) for per-bot citation counts if Pro
 *
 * Registers as window.AMCP_SECTIONS['surfaces']. */
(function () {
  'use strict';

  var rendered = false;
  var RAILWAY_API = 'https://api.advocatemcp.com';

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function currentSlug() {
    return (window.AMCP_DATA && window.AMCP_DATA.slug) ||
      new URLSearchParams(window.location.search).get('slug') || '';
  }

  function currentPlan() {
    return (window.AMCP_DATA && window.AMCP_DATA.plan) || 'free';
  }

  function showError(msg) {
    var el = document.getElementById('surfaces-error');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
  }

  function badge(state, text) {
    // Reuses existing .badge .badge-{green,yellow,red,accent} classes.
    var cls = 'badge-yellow';
    if (state === 'live')    cls = 'badge-green';
    else if (state === 'install') cls = 'badge-accent';
    else if (state === 'pending') cls = 'badge-yellow';
    else if (state === 'off')     cls = 'badge-red';
    return '<span class="badge ' + cls + '"><span class="badge-dot"></span>' + esc(text) + '</span>';
  }

  // Render the status table. Rows reflect:
  //   - Surfaces that are ALWAYS live (our own MCP, the JSON-LD endpoint,
  //     crawler interception when on a custom domain).
  //   - Surfaces that are pending directory submission (Smithery, PulseMCP,
  //     Anthropic's MCP registry), static rows while we work through
  //     outreach.
  //   - Surfaces derived from the radar summary when available (Perplexity,
  //     ChatGPT) so the tenant sees real "you were cited X/Y times" counts.
  function renderTable(radarSummary) {
    var wrap = document.getElementById('surfaces-table');
    if (!wrap) return;

    var isPro    = currentPlan() === 'pro';
    var isHosted = !!(window.AMCP_DATA && window.AMCP_DATA.is_hosted);

    // Build radar-derived stats. by_bot comes from the /summary response
    // (one row per provider in the 30-day window). Empty → tenant hasn't
    // been polled yet.
    var byBot = {};
    if (radarSummary && Array.isArray(radarSummary.by_bot)) {
      radarSummary.by_bot.forEach(function (r) { byBot[r.bot] = r; });
    }

    function botStatus(key) {
      var r = byBot[key];
      if (!r || r.total === 0) return { state: 'pending', text: 'No polls yet' };
      var pct = Math.round((r.citation_rate || 0) * 100);
      return { state: pct > 0 ? 'live' : 'off',
               text: r.cited + '/' + r.total + ' polls cited (' + pct + '%)' };
    }
    var perplexity = isPro ? botStatus('perplexity') : { state: 'pending', text: 'Pro tier' };
    var openai     = isPro ? botStatus('openai')     : { state: 'pending', text: 'Pro tier' };

    var rows = [
      {
        name: 'AdvocateMCP central',
        hint: 'api.advocatemcp.com/mcp, any AI assistant that speaks MCP can connect',
        status: badge('live', 'Live'),
      },
      {
        name: 'AI crawler interception',
        hint: isHosted
          ? 'Your hosted subdomain catches GPTBot, PerplexityBot, ClaudeBot, etc.'
          : 'Your custom domain catches GPTBot, PerplexityBot, ClaudeBot, etc.',
        status: badge('live', 'Live'),
      },
      {
        name: 'Google SGE / Bing Copilot',
        hint: 'Schema.org JSON-LD, paste the snippet below into your site &lt;head&gt;',
        status: badge('install', 'Install snippet'),
      },
      {
        name: 'Perplexity',
        hint: 'Weekly polled to confirm citation (Pro tier)',
        status: badge(perplexity.state, perplexity.text),
      },
      {
        name: 'ChatGPT (OpenAI)',
        hint: 'Weekly polled to confirm citation (Pro tier)',
        status: badge(openai.state, openai.text),
      },
      {
        name: 'Smithery (MCP directory)',
        hint: 'Developer-facing directory of MCP servers',
        status: badge('pending', 'Submission in progress'),
      },
      {
        name: 'PulseMCP (MCP directory)',
        hint: 'Developer-facing directory of MCP servers',
        status: badge('pending', 'Submission in progress'),
      },
      {
        name: 'Anthropic MCP registry',
        hint: 'Official registry for Claude Desktop / API clients',
        status: badge('pending', 'Submission in progress'),
      },
      {
        name: 'Google Agent2Agent (A2A)',
        hint: 'A2A protocol registry, infrastructure in place, listing pending',
        status: badge('pending', 'Coming soon'),
      },
    ];

    var html =
      '<table style="width:100%"><thead><tr>' +
        '<th style="text-align:left">Surface</th>' +
        '<th style="text-align:left;min-width:180px">Status</th>' +
      '</tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr>' +
          '<td style="padding:10px 8px">' +
            '<div style="font-size:var(--tx-sm);font-weight:600">' + esc(r.name) + '</div>' +
            '<div style="font-size:var(--tx-xs);color:var(--muted);margin-top:2px">' + r.hint + '</div>' +
          '</td>' +
          '<td style="padding:10px 8px">' + r.status + '</td>' +
          '</tr>';
      }).join('') +
      '</tbody></table>';
    wrap.innerHTML = html;
  }

  // Fetch the public JSON-LD and render the install snippet. Cross-origin
  // GET against Railway; the endpoint emits ACAO: * so this just works.
  function renderSnippet(slug) {
    var pre   = document.getElementById('surfaces-snippet');
    var copy  = document.getElementById('surfaces-copy');
    var stat  = document.getElementById('surfaces-copy-status');
    if (!pre || !copy) return;

    var url = RAILWAY_API + '/agents/' + encodeURIComponent(slug) + '/json-ld.json';
    fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error('http_' + r.status);
        return r.text();
      })
      .then(function (jsonText) {
        var snippet =
          '<script type="application/ld+json">\n' +
          jsonText +
          '\n<\/script>';
        pre.querySelector('code').textContent = snippet;

        copy.onclick = function () {
          if (!navigator.clipboard) {
            if (stat) stat.textContent = 'Clipboard not available, select manually.';
            return;
          }
          navigator.clipboard.writeText(snippet)
            .then(function () {
              if (stat) stat.textContent = 'Copied! Paste into your site\'s <head> section.';
              setTimeout(function () { if (stat) stat.textContent = ''; }, 4000);
            })
            .catch(function () {
              if (stat) stat.textContent = 'Copy failed, please select and copy manually.';
            });
        };
      })
      .catch(function (err) {
        pre.querySelector('code').textContent = '// Could not load snippet (' +
          (err && err.message ? err.message : 'error') + '). Reload the page to retry.';
      });
  }

  function render() {
    if (rendered) return;
    rendered = true;

    var slug = currentSlug();
    if (!slug) {
      showError('No business selected.');
      return;
    }

    // Table paint 1, no radar data yet, surfaces that don't depend on it
    // render immediately so the section isn't blank while the radar fetch
    // is in flight.
    renderTable(null);
    renderSnippet(slug);

    // Pull radar summary for per-bot citation counts. Non-fatal on any
    // failure; the table falls back to "pending" rows.
    if (currentPlan() === 'pro' && window.AMCP && window.AMCP.authedFetch) {
      var path = '/api/client/radar' + (slug ? '?slug=' + encodeURIComponent(slug) : '');
      window.AMCP.authedFetch(path)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (data && data.summary) renderTable(data.summary);
        })
        .catch(function () { /* silent, table already rendered */ });
    }
  }

  window.AMCP_SECTIONS = window.AMCP_SECTIONS || {};
  window.AMCP_SECTIONS['surfaces'] = render;
})();

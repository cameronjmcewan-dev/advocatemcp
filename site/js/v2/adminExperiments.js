/* v2 Admin · Format Experiments — runs the LLM-as-judge harness via
 * the worker proxy and renders the report inline.
 *
 * Worker route: POST /api/admin/experiments/format-judge
 *   - Auth: admin session (re-uses the same session as Mission Control)
 *   - Forwards to Railway with ADMIN_API_KEY injected server-side
 *   - Body: { profile_slugs?, queries?, variant_ids?, judges? }  (all optional)
 *
 * Cost: ~$0.50–$1 per default run. Visible in the report after each run.
 *
 * The admin endpoint is slow (Claude API trial loop, ~5s per trial × 30
 * trials = ~2.5 minutes default). UI shows a determinate-ish status
 * line during the wait. */

(function () {
  'use strict';

  function isAdmin() {
    const d = window.AMCP_DATA || {};
    return d.user_role === 'admin';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // No fetchReal needed — the experiment is on-demand via the Run button.
  async function fetchReal() { return {}; }

  function renderForbidden() {
    return `
      <div class="plain-banner" style="background:var(--maroon-wash);border-color:var(--maroon-tint)">
        <strong>Admin only.</strong>
        Format experiments measure how well each AI engine cites different presentation formats.
      </div>
    `;
  }

  function render() {
    if (!window.__ADVOCATE_PREVIEW && !isAdmin()) return renderForbidden();

    return `
      <div class="row single">
        <div class="card-dash">
          <div class="card-head">
            <div>
              <h3>Format Judge</h3>
              <div class="sub">Run the LLM-as-judge harness against any tenant. Measures how each AI engine would score 6 presentation formats for citability.</div>
            </div>
          </div>

          <div style="display:flex;flex-wrap:wrap;gap:14px;margin-top:18px;align-items:flex-end">
            <div style="flex:1;min-width:200px">
              <label style="display:block;font-size:12px;color:var(--muted);margin-bottom:4px">Tenant slug (optional)</label>
              <input id="exp-slug" type="text" placeholder="workman-copy-co" autocomplete="off"
                     style="width:100%;padding:8px 12px;border:1px solid var(--line);border-radius:8px;font-size:14px;background:var(--paper);color:var(--ink)">
            </div>
            <div style="flex:2;min-width:300px">
              <label style="display:block;font-size:12px;color:var(--muted);margin-bottom:4px">Queries (one per line, blank = use defaults)</label>
              <textarea id="exp-queries" rows="3" placeholder="best email marketing agency for DTC&#10;Klaviyo specialist agencies near me"
                        style="width:100%;padding:8px 12px;border:1px solid var(--line);border-radius:8px;font-size:13.5px;background:var(--paper);color:var(--ink);font-family:var(--mono)"></textarea>
            </div>
            <div style="display:flex;flex-direction:column;gap:6px">
              <button id="exp-run" type="button" class="btn btn-primary">Run experiment →</button>
              <button id="exp-run-whatif" type="button" class="btn btn-ghost btn-sm" title="Run with simulated Google + Yelp ratings injected via profile_patches — shows the score lift third-party verification would unlock without modifying the tenant's actual profile.">+ What-if: simulated ratings</button>
            </div>
          </div>
          <div id="exp-status" class="exp-status" aria-live="polite"></div>
        </div>
      </div>

      <div id="exp-results"></div>
    `;
  }

  function setStatus(msg, kind) {
    const el = document.getElementById('exp-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'exp-status' + (kind ? ' ' + kind : '');
  }

  function renderSummaryTable(summary) {
    if (!summary || !summary.length) return '<p style="color:var(--muted)">No trials returned.</p>';
    const max = Math.max(1, ...summary.map((s) => s.mean_citability));
    const rows = summary.map((s, i) => `
      <tr class="rank-${i + 1}">
        <td style="font-variant-numeric:tabular-nums;color:var(--muted);width:36px">${i + 1}</td>
        <td><code style="font-size:12.5px">${esc(s.variant_id)}</code></td>
        <td style="width:120px">
          <div class="exp-bar"><div class="exp-bar-fill" style="width:${Math.round((s.mean_citability / 10) * 100)}%"></div></div>
        </td>
        <td class="t">${s.mean_citability.toFixed(2)}</td>
        <td class="t">±${s.stddev_citability.toFixed(2)}</td>
        <td class="t">${Math.round(s.cite_rate * 100)}%</td>
        <td class="t">${s.trial_count}</td>
        <td class="t">$${s.total_cost_usd.toFixed(4)}</td>
      </tr>
    `).join('');
    return `
      <table class="exp-summary-table">
        <thead>
          <tr>
            <th></th>
            <th>Variant</th>
            <th>Score</th>
            <th class="t">Mean</th>
            <th class="t">Stddev</th>
            <th class="t">Cite rate</th>
            <th class="t">Trials</th>
            <th class="t">Cost</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  /* Per-query × per-variant heatmap. Surfaces the existing per-trial
   * data in a compact grid so high-variance variants (e.g. claude_html
   * ±1.50 in iter12) are immediately visible — the bad cell stands out
   * red while the good ones are green. Click any cell to expand the
   * judge's reasoning for that specific (query × variant) pair. */
  function renderQueryMatrix(trials, queries, variants) {
    if (!trials || !trials.length) return '';
    // Build a lookup: trials[query][variant] = trial
    const cell = new Map();
    for (const t of trials) {
      cell.set(`${t.query}|${t.variant_id}`, t);
    }
    const colorFor = (s) => {
      if (s >= 8) return '#2c5d3a';        // green
      if (s >= 6) return '#7a6014';        // amber
      if (s >= 4) return '#7d2550';        // maroon
      return '#5c1c30';                    // dark red
    };
    const fadeFor = (s) => {
      if (s >= 8) return 'rgba(44,93,58,.15)';
      if (s >= 6) return 'rgba(122,96,20,.15)';
      if (s >= 4) return 'rgba(125,37,80,.18)';
      return 'rgba(92,28,48,.25)';
    };
    const variantHeaders = variants.map((v) => `<th class="t" style="font-size:11px"><code>${esc(v)}</code></th>`).join('');
    const rows = queries.map((q) => {
      const cells = variants.map((v) => {
        const t = cell.get(`${q}|${v}`);
        if (!t) return `<td class="t" style="color:var(--muted)">—</td>`;
        const score = t.citability_score;
        return `
          <td class="t exp-cell" style="background:${fadeFor(score)};color:${colorFor(score)};font-weight:600" title="${esc(t.reasoning).slice(0, 220)}">
            ${score}
          </td>
        `;
      }).join('');
      return `
        <tr>
          <td style="font-size:12.5px;color:var(--ink-2);max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(q)}">${esc(q.slice(0, 56))}</td>
          ${cells}
        </tr>
      `;
    }).join('');
    return `
      <table class="exp-summary-table">
        <thead>
          <tr>
            <th>Query</th>
            ${variantHeaders}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-top:8px;font-size:11.5px;color:var(--muted)">Hover a cell for the judge's reasoning. <span style="color:#2c5d3a">●</span> ≥ 8 · <span style="color:#7a6014">●</span> 6-7 · <span style="color:#7d2550">●</span> 4-5 · <span style="color:#5c1c30">●</span> ≤ 3</div>
    `;
  }

  function renderTrialDetails(trials) {
    if (!trials || !trials.length) return '';
    const byVariant = new Map();
    for (const t of trials) {
      if (!byVariant.has(t.variant_id)) byVariant.set(t.variant_id, []);
      byVariant.get(t.variant_id).push(t);
    }
    const blocks = Array.from(byVariant.entries()).map(([vid, ts]) => {
      // Surface the WORST trial (lowest score) instead of trial[0] —
      // that's where the actionable deduction lives. iter12 showed
      // claude_html had 8s and 5s in the same variant; trial[0] hid
      // the 5's reasoning behind a single-trial sample view.
      const worst = ts.slice().sort((a, b) => a.citability_score - b.citability_score)[0];
      const best = ts.slice().sort((a, b) => b.citability_score - a.citability_score)[0];
      const allScores = ts.map((t) => t.citability_score).join(', ');
      const variance = ts.length > 1 ? `range ${best.citability_score - worst.citability_score}` : 'single trial';
      return `
        <details class="exp-details">
          <summary><code>${esc(vid)}</code> — ${ts.length} trials, ${variance}, scores: ${allScores}</summary>
          <div style="padding:8px 16px;font-size:13px;color:var(--ink-2);line-height:1.5">
            <strong style="color:#7d2550">Worst trial · score ${worst.citability_score}/10 · query "${esc(worst.query.slice(0, 60))}"</strong>
            <p style="margin:8px 0 12px">${esc(worst.reasoning)}</p>
            ${best.citability_score !== worst.citability_score ? `
              <strong style="color:#2c5d3a">Best trial · score ${best.citability_score}/10 · query "${esc(best.query.slice(0, 60))}"</strong>
              <p style="margin:8px 0 0">${esc(best.reasoning)}</p>
            ` : ''}
          </div>
        </details>
      `;
    }).join('');
    return blocks;
  }

  function renderResults(result) {
    const cfg = result.cfg || {};
    const totalCost = (result.summary || []).reduce((a, s) => a + (s.total_cost_usd || 0), 0);
    const totalTrials = (result.trials || []).length;
    return `
      <div class="row single" style="margin-top:18px">
        <div class="card-dash">
          <div class="card-head">
            <div>
              <h3>Latest results</h3>
              <div class="sub">${(cfg.profiles || []).length} profile(s) · ${(cfg.queries || []).length} queries · ${(cfg.variants || []).length} variants · ${(cfg.judges || []).length} judge(s) · ${totalTrials} trials · $${totalCost.toFixed(4)} total</div>
            </div>
          </div>
          <div style="margin-top:14px">
            ${renderSummaryTable(result.summary)}
          </div>
          ${(cfg.queries || []).length > 1 ? `
            <div style="margin-top:22px">
              <strong style="font-size:13px">Per-query × per-variant scores</strong>
              <div style="margin-top:6px">
                ${renderQueryMatrix(result.trials || [], cfg.queries || [], cfg.variants || [])}
              </div>
            </div>
          ` : ''}
          <div style="margin-top:18px">
            <strong style="font-size:13px">Per-variant reasoning (worst + best trial)</strong>
            <div style="margin-top:6px">
              ${renderTrialDetails(result.trials)}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // Default queries used when the textarea is left blank — kept in sync
  // with server/src/experiments/formatJudge/runner.ts DEFAULT_QUERIES.
  const DEFAULT_QUERIES = [
    'best email marketing agency for DTC ecommerce',
    'Klaviyo specialist agencies near me',
    'tell me about Workman Copy Co',
    'email agency for shopify stores',
    'compare email marketing services for small DTC brands',
  ];

  // Cloudflare's edge proxy times out at ~100s for any single subrequest.
  // 30 trials × 5s each = 150s = 524. So we chunk client-side: split the
  // query list into batches of 2 (≈12 trials × 5s = 60s per batch, well
  // under the limit), run them sequentially, and merge the results
  // before rendering.
  const QUERIES_PER_BATCH = 2;

  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  function mergeResults(batches) {
    const merged = {
      cfg: { profiles: [], queries: [], variants: [], judges: [] },
      trials: [],
      summary: [],
      report_md: '',
    };
    for (const r of batches) {
      if (r.cfg) {
        for (const p of r.cfg.profiles || []) {
          if (!merged.cfg.profiles.find((x) => x.slug === p.slug)) merged.cfg.profiles.push(p);
        }
        for (const q of r.cfg.queries || []) {
          if (!merged.cfg.queries.includes(q)) merged.cfg.queries.push(q);
        }
        for (const v of r.cfg.variants || []) {
          if (!merged.cfg.variants.includes(v)) merged.cfg.variants.push(v);
        }
        for (const j of r.cfg.judges || []) {
          if (!merged.cfg.judges.includes(j)) merged.cfg.judges.push(j);
        }
      }
      merged.trials.push(...(r.trials || []));
    }
    // Re-aggregate summary across all trials.
    const byVariant = new Map();
    for (const t of merged.trials) {
      if (!byVariant.has(t.variant_id)) byVariant.set(t.variant_id, []);
      byVariant.get(t.variant_id).push(t);
    }
    merged.summary = Array.from(byVariant.entries()).map(([variant_id, ts]) => {
      const scores = ts.map((t) => t.citability_score).filter((s) => s > 0);
      const mean = scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length);
      const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, scores.length);
      const cites = ts.filter((t) => t.would_cite).length;
      // Cost approximation: each trial logs its own cost via judge model
      // pricing, but we don't have it inline — fall back to summing the
      // per-batch summary's reported cost.
      let cost = 0;
      for (const r of batches) {
        for (const s of r.summary || []) {
          if (s.variant_id === variant_id) cost += (s.total_cost_usd || 0);
        }
      }
      return {
        variant_id,
        trial_count: ts.length,
        mean_citability: Number(mean.toFixed(2)),
        stddev_citability: Number(Math.sqrt(variance).toFixed(2)),
        cite_rate: Number((cites / Math.max(1, ts.length)).toFixed(2)),
        total_cost_usd: Number(cost.toFixed(4)),
      };
    }).sort((a, b) => b.mean_citability - a.mean_citability);
    return merged;
  }

  // Simulated third-party ratings used by the What-if button. Lets the
  // operator preview the score lift a tenant would unlock by adding
  // verified ratings WITHOUT mutating their live profile.
  const WHAT_IF_PATCH = {
    ratings_json: {
      google: { rating: 4.9, count: 47, url: "https://www.google.com/maps/place/Workman+Copy+Co" },
      yelp:   { rating: 5.0, count: 12, url: "https://www.yelp.com/biz/workman-copy-co-austin" },
    },
    customer_quotes_json: [
      { author: "Anya R.",  quote: "Workman Copy Co rebuilt our entire Klaviyo flow set in 6 weeks and we hit a 28% lift in email revenue.", source: "google" },
      { author: "Devon P.", quote: "Their copy reads like our customers wrote it. We finally stopped sending generic blasts.",                source: "yelp" },
      { author: "Jin S.",   quote: "Worked with three other agencies before. None understood DTC like Workman does.",                            source: "google" },
    ],
  };

  async function runExperiment(opts) {
    opts = opts || {};
    const slugInput = document.getElementById('exp-slug');
    const queriesInput = document.getElementById('exp-queries');
    const btn = document.getElementById('exp-run');
    const btnWhatIf = document.getElementById('exp-run-whatif');
    const resultsEl = document.getElementById('exp-results');
    if (!btn || !resultsEl) return;

    const slug = (slugInput && slugInput.value || '').trim();
    const customQueries = (queriesInput && queriesInput.value || '')
      .split('\n').map((s) => s.trim()).filter(Boolean);
    const queries = customQueries.length ? customQueries : DEFAULT_QUERIES;
    const batches = chunk(queries, QUERIES_PER_BATCH);

    btn.disabled = true;
    if (btnWhatIf) btnWhatIf.disabled = true;
    const started = Date.now();
    setStatus(`Running ${batches.length} batch(es) of ${QUERIES_PER_BATCH} queries to stay under Cloudflare's 100s edge timeout…`);

    const ticker = setInterval(() => {
      const elapsed = Math.round((Date.now() - started) / 1000);
      setStatus(`Running… ${elapsed}s elapsed`);
    }, 2000);

    try {
      const af = window.AMCP && window.AMCP.authedFetch;
      if (!af) { setStatus('Auth wrapper missing.', 'error'); return; }

      const results = [];
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const elapsed = Math.round((Date.now() - started) / 1000);
        setStatus(`Batch ${i + 1}/${batches.length} (${batch.length} queries × 6 variants = ~${batch.length * 6 * 5}s)… ${elapsed}s elapsed`);
        const body = { queries: batch };
        if (slug) body.profile_slugs = [slug];
        // What-if mode: inject simulated third-party ratings on the
        // target tenant's profile via profile_patches. Server merges
        // them on top of the loaded BusinessRow before rendering, so
        // the experiment scores the HYPOTHETICAL state without
        // mutating the tenant's live record.
        if (opts.whatIf && slug) {
          body.profile_patches = { [slug]: WHAT_IF_PATCH };
        }
        const res = await af('/api/admin/experiments/format-judge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          if (res.status === 503) {
            clearInterval(ticker);
            setStatus(
              'Worker missing ADMIN_API_KEY secret. Run on terminal: cd worker && npx wrangler secret put ADMIN_API_KEY (paste the same key Railway uses).',
              'error',
            );
            return;
          }
          if (res.status === 524) {
            clearInterval(ticker);
            setStatus(
              `Cloudflare edge timeout on batch ${i + 1}. Try fewer queries (${QUERIES_PER_BATCH} per batch should work).`,
              'error',
            );
            return;
          }
          clearInterval(ticker);
          setStatus(`Batch ${i + 1} failed: ${err.error || 'HTTP ' + res.status}`, 'error');
          return;
        }
        results.push(await res.json());
      }
      clearInterval(ticker);
      const merged = mergeResults(results);
      const elapsed = Math.round((Date.now() - started) / 1000);
      setStatus(`Done — ${merged.trials.length} trials across ${batches.length} batch(es) in ${elapsed}s.`, 'ok');
      resultsEl.innerHTML = renderResults(merged);
    } catch (err) {
      clearInterval(ticker);
      setStatus('Network error: ' + String((err && err.message) || err), 'error');
    } finally {
      btn.disabled = false;
      if (btnWhatIf) btnWhatIf.disabled = false;
    }
  }

  function afterMount() {
    const btn = document.getElementById('exp-run');
    if (btn) btn.addEventListener('click', () => runExperiment());
    const btnWhatIf = document.getElementById('exp-run-whatif');
    if (btnWhatIf) btnWhatIf.addEventListener('click', () => runExperiment({ whatIf: true }));
  }

  window.AMCP_ADMIN_EXPERIMENTS = {
    demo:  () => ({}),
    fetch: fetchReal,
    render,
    afterMount,
  };
})();

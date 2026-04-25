/* v2 Business Profile — port of the 19-field form + Agent Operations
 * editor (hours / pricing / routing / timezone / webhook) from the
 * legacy dashboard-settings.js into the new paper chrome.
 *
 * Reads and writes via:
 *   GET  /api/client/profile?slug=:slug
 *   POST /api/client/profile?slug=:slug   (partial update, allow-listed)
 *
 * Three stacked save forms — Basics, Positioning & reputation, and
 * Agent Operations — so one card's save isn't bottlenecked by another's
 * validation errors. All three hit the same PATCH endpoint; fields just
 * get scoped per form. */
(function () {
  'use strict';

  const DEMO = {
    slug: 'preview-demo',
    business_name: 'Preview Business',
    plan: 'base',
    profile: {
      name:                 'Preview Business',
      description:          'A preview tenant used to demo the new Advocate dashboard.',
      category:             'Florist',
      services:             ['Same-day delivery', 'Wedding florist', 'Sympathy arrangements', 'Corporate orders'],
      website:              'https://example.com',
      referral_url:         'https://example.com/order',
      phone:                '+1 512 555 0164',
      location:             'Austin, TX',
      tone:                 'friendly',
      pricing_tier:         'mid-range',
      pricing:              '$40–$250 typical order',
      years_in_business:    8,
      top_services:         ['Same-day delivery', 'Wedding florist'],
      star_rating:          4.8,
      review_count:         312,
      service_radius_miles: 25,
      service_area_keywords:['Austin', 'South Austin', 'Round Rock', 'Cedar Park'],
      certifications:       ['Austin Chamber', 'BBB A+'],
      differentiator:       'Family-owned since 2018 · seasonal arrangements from local growers · 2-hour delivery windows.',
      availability:         'Mon–Sat 9am–7pm · Sun 10am–5pm',
      hours_json: {
        mon: { open: '09:00', close: '19:00' }, tue: { open: '09:00', close: '19:00' },
        wed: { open: '09:00', close: '19:00' }, thu: { open: '09:00', close: '19:00' },
        fri: { open: '09:00', close: '19:00' }, sat: { open: '09:00', close: '19:00' },
        sun: { open: '10:00', close: '17:00' }, emergency_24_7: false,
      },
      pricing_json_v2: {
        ranges: [
          { service: 'Same-day bouquet', min: 40, max: 120, unit: 'job' },
          { service: 'Wedding package',  min: 450, max: 2500, unit: 'job' },
          { service: 'Corporate retainer', min: 800, max: 3000, unit: 'job' },
        ],
        call_for_quote: false, free_estimates: true,
      },
      lead_routing_json: {
        preferred_channel: 'text',
        phone: '+15125550164',
        email: 'orders@example.com',
      },
      timezone: 'America/Chicago',
      availability_webhook_url: null,
    },
  };

  async function fetchReal() {
    const af = window.AMCP && window.AMCP.authedFetch;
    const slug = (window.AMCP_DATA && window.AMCP_DATA.slug)
      || (new URLSearchParams(location.search).get('slug'))
      || '';
    const suffix = slug ? `?slug=${encodeURIComponent(slug)}` : '';
    const [me, metrics, profile] = await Promise.all([
      af('/api/client/me').then(r => r.ok ? r.json() : null).catch(() => null),
      af('/api/client/metrics').then(r => r.ok ? r.json() : null).catch(() => null),
      af('/api/client/profile' + suffix).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    return Object.assign({}, metrics || {}, {
      profile: profile || {},
      _me: me,
    });
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function csvJoin(v) { return Array.isArray(v) ? v.join(', ') : (v == null ? '' : String(v)); }
  function num(v) {
    const n = Number(v); return Number.isFinite(n) ? n : '';
  }

  const DAYS = [
    { key: 'mon', label: 'Mon' }, { key: 'tue', label: 'Tue' },
    { key: 'wed', label: 'Wed' }, { key: 'thu', label: 'Thu' },
    { key: 'fri', label: 'Fri' }, { key: 'sat', label: 'Sat' },
    { key: 'sun', label: 'Sun' },
  ];
  const UNITS = ['job', 'hour', 'visit', 'sqft'];

  /* AI citation score card. Calls POST /api/client/profile-score on
   * demand — runs the format-judge harness against THIS tenant's
   * profile and returns a 0-10 score plus actionable improvements
   * mapped from the judge's deductions. The same harness used in
   * /admin/experiments.html for ops-side measurement, but scoped to
   * the calling tenant only and surfacing customer-friendly UX.
   *
   * Cost per click: ~$0.04. The "Run check" button is disabled
   * during the ~30-45s call so a tenant can't click it 100x. */
  function renderScoreCard(p) {
    return `
      <div class="card-dash" id="score-card">
        <div class="card-head">
          <div>
            <h3>AI citation score</h3>
            <div class="sub">How likely are AI search engines to cite your business when someone asks about you? We measure this against the same models AI engines run.</div>
          </div>
          <div>
            <button id="btn-run-score" type="button" class="btn btn-primary btn-sm">Run AI score check →</button>
          </div>
        </div>
        <div id="score-result" style="margin-top:14px"></div>
      </div>
    `;
  }

  function renderScoreResult(data) {
    if (!data) return "";
    const score = (data.score != null ? data.score : 0).toFixed(1);
    const max = data.score_max || 10;
    const cite = (data.cite_rate != null ? data.cite_rate : 0);
    const variants = data.per_variant || [];
    const improvements = data.improvements || [];
    const fillPct = Math.round((data.score / max) * 100);

    const variantRows = variants.map((v) => {
      const labelMap = {
        perplexity_html: "Perplexity",
        openai_html:     "ChatGPT",
        claude_html:     "Claude",
        google_html:     "Google AI Overview",
      };
      const label = labelMap[v.variant_id] || v.variant_id;
      const pct = Math.round((v.score / 10) * 100);
      return `
        <tr>
          <td>${esc(label)}</td>
          <td style="width:120px"><div class="score-bar"><div class="score-bar-fill" style="width:${pct}%"></div></div></td>
          <td class="t" style="font-variant-numeric:tabular-nums">${v.score.toFixed(1)}/10</td>
        </tr>
      `;
    }).join("");

    const improvementsHtml = improvements.length === 0
      ? `<p style="color:var(--muted);font-size:13.5px;margin:8px 0 0">No specific improvements suggested — your score is high. Re-run after adding more profile data to keep tracking.</p>`
      : improvements.map((i) => `
          <div class="score-tip">
            <div class="score-tip-lift">+${i.expected_lift.toFixed(1)}</div>
            <div class="score-tip-body">
              <div class="score-tip-reason">${esc(i.reason)}</div>
              <a class="score-tip-link" href="${esc(i.href)}">Open ${esc(prettyField(i.field))} →</a>
            </div>
          </div>
        `).join("");

    return `
      <div class="score-summary">
        <div class="score-bigwheel">
          <div class="score-num">${score}<span class="score-num-max">/${max}</span></div>
          <div class="score-num-label">${cite}% cite rate</div>
        </div>
        <div class="score-table-wrap">
          <table class="score-table">
            <thead><tr><th>AI engine</th><th></th><th class="t">Score</th></tr></thead>
            <tbody>${variantRows}</tbody>
          </table>
        </div>
      </div>
      <div class="score-improvements">
        <strong>Top opportunities to improve</strong>
        ${improvementsHtml}
      </div>
      <div class="score-meta">
        Last run: ${esc(new Date(data.run_at || Date.now()).toLocaleString())} · Re-run anytime · ~30s · ~$0.04/run
      </div>
    `;
  }

  /* Pretty label for an internal profile field name. Used in the
   * "Open <field>" CTA inside score improvements. */
  function prettyField(f) {
    const map = {
      ratings_json:         "Verified ratings",
      customer_quotes_json: "Customer quotes",
      credentials_json:     "Credentials",
      differentiator:       "Positioning",
      pricing_json_v2:      "Pricing",
      _internal:            "Settings",
    };
    return map[f] || f;
  }

  function renderBasicsCard(p) {
    return `
      <div class="card-dash" data-form="basics">
        <div class="card-head"><div><h3>Basics</h3><div class="sub">The essentials AI tools pull first</div></div></div>
        <form id="form-basics" class="prof-form">
          <div class="prof-row">
            <label>Business name
              <input type="text" value="${esc(p.name || (window.AMCP_DATA && window.AMCP_DATA.business_name) || '')}" disabled title="Name is tied to your slug — contact support to rename.">
            </label>
          </div>
          <div class="prof-row">
            <label>One-line description
              <input type="text" name="description" value="${esc(p.description || '')}" placeholder="A short pitch AI will quote when citing your business.">
            </label>
          </div>
          <div class="prof-row-2">
            <label>Category
              <input type="text" name="category" value="${esc(p.category || '')}" placeholder='e.g. "Florist"'>
            </label>
            <label>Phone
              <input type="tel" name="phone" value="${esc(p.phone || '')}" placeholder="+1 555 123 4567">
            </label>
          </div>
          <div class="prof-row-2">
            <label>Website
              <input type="url" name="website" value="${esc(p.website || '')}" placeholder="https://example.com">
            </label>
            <label>Location
              <input type="text" name="location" value="${esc(p.location || '')}" placeholder="Austin, TX">
            </label>
          </div>
          <div class="prof-row">
            <label>Referral URL (where AI sends interested visitors)
              <input type="url" name="referral_url" value="${esc(p.referral_url || '')}" placeholder="https://example.com/contact">
            </label>
          </div>
          <div class="prof-row">
            <label>Services (comma separated)
              <input type="text" name="services" value="${esc(csvJoin(p.services))}" placeholder="Same-day delivery, Wedding florist, Sympathy arrangements">
            </label>
          </div>
          <div class="prof-actions">
            <button class="btn btn-primary btn-sm" type="submit">Save basics</button>
            <span class="prof-status"></span>
          </div>
        </form>
      </div>
    `;
  }

  function renderPositioningCard(p) {
    return `
      <div class="card-dash" data-form="positioning">
        <div class="card-head"><div><h3>Positioning &amp; reputation</h3><div class="sub">How the AI talks about you when it cites</div></div></div>
        <form id="form-positioning" class="prof-form">
          <div class="prof-row">
            <label>Differentiator
              <textarea name="differentiator" rows="2" placeholder="One or two sentences on what makes you different.">${esc(p.differentiator || '')}</textarea>
            </label>
          </div>
          <div class="prof-row">
            <label>Top services (comma separated, 1–3 standouts)
              <input type="text" name="top_services" value="${esc(csvJoin(p.top_services))}" placeholder="Same-day delivery, Wedding florist">
            </label>
          </div>
          <div class="prof-row-2">
            <label>Tone
              <select name="tone">
                ${['', 'friendly', 'professional', 'luxury'].map(v => `<option value="${v}" ${p.tone === v ? 'selected' : ''}>${v ? v[0].toUpperCase() + v.slice(1) : '—'}</option>`).join('')}
              </select>
            </label>
            <label>Pricing tier
              <select name="pricing_tier">
                ${['', 'budget', 'mid-range', 'premium'].map(v => `<option value="${v}" ${p.pricing_tier === v ? 'selected' : ''}>${v ? v[0].toUpperCase() + v.slice(1) : '—'}</option>`).join('')}
              </select>
            </label>
          </div>
          <div class="prof-row">
            <label>Pricing (free-form)
              <input type="text" name="pricing" value="${esc(p.pricing || '')}" placeholder='e.g. "$40–$250 typical order"'>
            </label>
          </div>
          <div class="prof-row-3">
            <label>Years in business
              <input type="number" min="0" name="years_in_business" value="${num(p.years_in_business)}">
            </label>
            <label>Star rating
              <input type="number" min="0" max="5" step="0.1" name="star_rating" value="${num(p.star_rating)}">
            </label>
            <label>Review count
              <input type="number" min="0" name="review_count" value="${num(p.review_count)}">
            </label>
          </div>
          <div class="prof-row">
            <label>Service radius (miles)
              <input type="number" min="0" name="service_radius_miles" value="${num(p.service_radius_miles)}">
            </label>
          </div>
          <div class="prof-row">
            <label>Service-area keywords (comma separated)
              <input type="text" name="service_area_keywords" value="${esc(csvJoin(p.service_area_keywords))}" placeholder="Austin, Round Rock, Cedar Park">
            </label>
          </div>
          <div class="prof-row">
            <label>Certifications (comma separated)
              <input type="text" name="certifications" value="${esc(csvJoin(p.certifications))}" placeholder="BBB A+, Chamber of Commerce">
            </label>
          </div>
          <div class="prof-row">
            <label>Availability (free-form)
              <input type="text" name="availability" value="${esc(p.availability || '')}" placeholder='e.g. "Mon–Fri 9am–6pm CT"'>
            </label>
          </div>
          <div class="prof-actions">
            <button class="btn btn-primary btn-sm" type="submit">Save positioning</button>
            <span class="prof-status"></span>
          </div>
        </form>
      </div>
    `;
  }

  /* Verified ratings card. Lets the tenant enter per-platform ratings
   * (Google / Yelp / Facebook / BBB) with optional URL pointing at the
   * actual review page. The renderer emits one schema.org Review block
   * per platform with publisher attribution — that's the third-party
   * verification signal the format-judge harness flagged as the
   * difference between 8/10 (self-reported) and 9-10 (verified). */
  function renderRatingsCard(p) {
    let ratings = {};
    try {
      if (p.ratings_json) {
        ratings = typeof p.ratings_json === "string"
          ? JSON.parse(p.ratings_json)
          : p.ratings_json;
      }
    } catch { ratings = {}; }
    const platforms = [
      { key: "google",   label: "Google reviews",   placeholder: "https://www.google.com/maps/place/..." },
      { key: "yelp",     label: "Yelp",             placeholder: "https://www.yelp.com/biz/..." },
      { key: "facebook", label: "Facebook",         placeholder: "https://www.facebook.com/..." },
      { key: "bbb",      label: "Better Business Bureau", placeholder: "https://www.bbb.org/..." },
    ];
    return `
      <div class="card-dash" data-form="ratings">
        <div class="card-head">
          <div>
            <h3>Verified ratings</h3>
            <div class="sub">Add the platforms you have a real listing on. AI search engines treat these as third-party verification — the single biggest lift to your citation score (~+1 to +2 points per platform on the format-judge harness).</div>
          </div>
        </div>
        <form id="form-ratings" class="prof-form">
          ${platforms.map(plat => {
            const r = ratings[plat.key] || {};
            return `
              <fieldset class="ops-group">
                <legend>${esc(plat.label)}</legend>
                <div class="prof-row-3">
                  <label>Rating
                    <input type="number" min="0" max="5" step="0.1" name="${plat.key}_rating" value="${r.rating != null ? r.rating : ''}" placeholder="4.8">
                  </label>
                  <label>Review count
                    <input type="number" min="0" name="${plat.key}_count" value="${r.count != null ? r.count : ''}" placeholder="127">
                  </label>
                  <label>URL (link to your reviews page)
                    <input type="url" name="${plat.key}_url" value="${esc(r.url || '')}" placeholder="${esc(plat.placeholder)}">
                  </label>
                </div>
              </fieldset>
            `;
          }).join('')}
          <div class="prof-actions">
            <button class="btn btn-primary btn-sm" type="submit">Save ratings</button>
            <span class="prof-status"></span>
          </div>
        </form>
      </div>
    `;
  }

  /* Customer quotes card. Each quote becomes a schema.org Review block
   * (separate from the platform-aggregate Review blocks above). When
   * the quote is sourced from a platform, the renderer adds a publisher
   * field naming that platform — a real review excerpt with named
   * source is highest-value for citation. */
  function renderQuotesCard(p) {
    let quotes = [];
    try {
      if (p.customer_quotes_json) {
        const raw = typeof p.customer_quotes_json === "string"
          ? JSON.parse(p.customer_quotes_json)
          : p.customer_quotes_json;
        if (Array.isArray(raw)) quotes = raw;
      }
    } catch { quotes = []; }
    // Pad to 3 rows so the user always sees room to add more.
    while (quotes.length < 3) quotes.push({ quote: "", author: "", source: "direct" });
    const sources = ["direct", "google", "yelp", "facebook", "bbb"];
    return `
      <div class="card-dash" data-form="quotes">
        <div class="card-head">
          <div>
            <h3>Customer quotes</h3>
            <div class="sub">Real testimonials from happy customers. Each one becomes a schema.org Review block — when sourced from Google or Yelp, the renderer also names the platform as publisher.</div>
          </div>
        </div>
        <form id="form-quotes" class="prof-form">
          <div id="quotes-list">
            ${quotes.map((q, i) => `
              <fieldset class="ops-group" data-quote-idx="${i}">
                <legend>Quote ${i + 1}</legend>
                <div class="prof-row">
                  <label>Quote
                    <textarea name="quote_${i}" rows="2" maxlength="500" placeholder="What did the customer actually say?">${esc(q.quote || '')}</textarea>
                  </label>
                </div>
                <div class="prof-row-2">
                  <label>Author
                    <input type="text" name="author_${i}" maxlength="120" value="${esc(q.author || '')}" placeholder="First name + last initial works (e.g. Anya R.)">
                  </label>
                  <label>Source
                    <select name="source_${i}">
                      ${sources.map(s => `<option value="${s}" ${q.source === s ? 'selected' : ''}>${s === 'direct' ? 'Direct (uploaded by you)' : s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
                    </select>
                  </label>
                </div>
              </fieldset>
            `).join('')}
          </div>
          <div class="prof-actions">
            <button type="button" class="btn btn-ghost btn-sm" id="btn-add-quote">+ Add another quote</button>
            <button class="btn btn-primary btn-sm" type="submit">Save quotes</button>
            <span class="prof-status"></span>
          </div>
        </form>
      </div>
    `;
  }

  function renderHoursGrid(hours) {
    return DAYS.map(d => {
      const day = hours && hours[d.key];
      const isOpen = !!(day && day.open && day.close);
      return `<div class="hrs-row">
        <span class="hrs-day">${d.label}</span>
        <input type="checkbox" data-hrs-open="${d.key}" ${isOpen ? 'checked' : ''}>
        <input type="time" class="fi" data-hrs-field="${d.key}-open"  value="${isOpen ? esc(day.open) : ''}" ${isOpen ? '' : 'disabled'}>
        <input type="time" class="fi" data-hrs-field="${d.key}-close" value="${isOpen ? esc(day.close) : ''}" ${isOpen ? '' : 'disabled'}>
      </div>`;
    }).join('');
  }

  function renderPricingRangeRow(r) {
    r = r || {};
    return `<div class="pr-row">
      <input type="text" class="fi" data-pr="service" value="${esc(r.service || '')}" placeholder="Service name">
      <input type="number" min="0" step="0.01" class="fi" data-pr="min" value="${num(r.min)}" placeholder="Min">
      <input type="number" min="0" step="0.01" class="fi" data-pr="max" value="${num(r.max)}" placeholder="Max">
      <select class="fi" data-pr="unit">
        ${UNITS.map(u => `<option value="${u}" ${(r.unit || 'job') === u ? 'selected' : ''}>per ${u}</option>`).join('')}
      </select>
      <button type="button" class="btn btn-ghost btn-sm" data-pr-remove style="padding:6px 10px">×</button>
    </div>`;
  }

  function renderOperationsCard(p) {
    const hours = p.hours_json || {};
    const pricingRanges = (p.pricing_json_v2 && p.pricing_json_v2.ranges) || [];
    const routing = p.lead_routing_json || {};
    return `
      <div class="card-dash" data-form="ops">
        <div class="card-head">
          <div><h3>Agent operations</h3><div class="sub">What powers the A2A tools — hours drive <code>get_availability</code> and <code>reserve_slot</code>, pricing drives <code>get_quote</code>, routing drives <code>initiate_handoff</code>.</div></div>
        </div>

        <form id="form-ops" class="prof-form">
          <fieldset class="ops-group">
            <legend>Hours</legend>
            <div id="hrs-grid">${renderHoursGrid(hours)}</div>
            <label class="hrs-247">
              <input type="checkbox" id="ops-emergency" ${hours.emergency_24_7 ? 'checked' : ''}>
              Emergency / 24×7 available (bypasses day grid for emergency services)
            </label>
            <div class="prof-row-2" style="margin-top:12px">
              <label>Timezone (IANA)
                <input type="text" name="timezone" value="${esc(p.timezone || '')}" placeholder="America/Chicago" list="tz-list">
                <datalist id="tz-list">
                  <option value="America/New_York"><option value="America/Chicago">
                  <option value="America/Denver"><option value="America/Los_Angeles">
                  <option value="America/Phoenix"><option value="America/Anchorage">
                  <option value="Pacific/Honolulu"><option value="Europe/London">
                  <option value="Europe/Berlin"><option value="UTC">
                </datalist>
              </label>
              <label>Availability webhook URL (v2 calendar integration, reserved)
                <input type="url" name="availability_webhook_url" value="${esc(p.availability_webhook_url || '')}" placeholder="https://">
              </label>
            </div>
          </fieldset>

          <fieldset class="ops-group">
            <legend>Pricing ranges</legend>
            <div id="pr-list">${pricingRanges.map(renderPricingRangeRow).join('')}</div>
            <button type="button" class="btn btn-ghost btn-sm" id="pr-add" style="align-self:flex-start;margin-top:8px">+ Add range</button>
            <div style="display:flex;gap:18px;margin-top:12px;font-size:13px;color:var(--ink-2)">
              <label><input type="checkbox" id="ops-cfq" ${p.pricing_json_v2 && p.pricing_json_v2.call_for_quote ? 'checked' : ''}> Call for quote</label>
              <label><input type="checkbox" id="ops-free-est" ${p.pricing_json_v2 && p.pricing_json_v2.free_estimates ? 'checked' : ''}> Free estimates</label>
            </div>
          </fieldset>

          <fieldset class="ops-group">
            <legend>Lead routing (initiate_handoff target)</legend>
            <label>Preferred channel
              <select id="ops-routing-channel">
                ${['', 'phone', 'text', 'email', 'form'].map(v => `<option value="${v}" ${routing.preferred_channel === v ? 'selected' : ''}>${v ? v[0].toUpperCase() + v.slice(1) : '—'}</option>`).join('')}
              </select>
            </label>
            <div class="prof-row-2" style="margin-top:8px">
              <label>Phone
                <input type="tel" id="ops-routing-phone" value="${esc(routing.phone || '')}" placeholder="+1 555 123 4567">
              </label>
              <label>Email
                <input type="email" id="ops-routing-email" value="${esc(routing.email || '')}" placeholder="leads@example.com">
              </label>
            </div>
            <label style="margin-top:8px">Web form URL
              <input type="url" id="ops-routing-form-url" value="${esc(routing.form_url || '')}" placeholder="https://example.com/contact">
            </label>
          </fieldset>

          <div class="prof-actions">
            <button class="btn btn-primary btn-sm" type="submit">Save operations</button>
            <span class="prof-status"></span>
          </div>
        </form>
      </div>
    `;
  }

  /* After render() is injected into the DOM, wire behaviors here. */
  function afterMount(data) {
    const p = (data && data.profile) || {};
    const preview = !!window.__ADVOCATE_PREVIEW;
    const slug = (window.AMCP_DATA && window.AMCP_DATA.slug) || '';

    // Hours grid — toggle day open/closed
    document.querySelectorAll('[data-hrs-open]').forEach(cb => {
      cb.addEventListener('change', () => {
        const k = cb.dataset.hrsOpen;
        const o = document.querySelector(`[data-hrs-field="${k}-open"]`);
        const c = document.querySelector(`[data-hrs-field="${k}-close"]`);
        o.disabled = !cb.checked; c.disabled = !cb.checked;
        if (cb.checked) {
          if (!o.value) o.value = '09:00';
          if (!c.value) c.value = '17:00';
        }
      });
    });

    // Pricing ranges — add row
    const addBtn = document.getElementById('pr-add');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        const list = document.getElementById('pr-list');
        if (!list) return;
        const tmp = document.createElement('div');
        tmp.innerHTML = renderPricingRangeRow({});
        const row = tmp.firstChild;
        list.appendChild(row);
        row.querySelector('[data-pr-remove]').addEventListener('click', () => row.remove());
      });
    }
    // Existing remove handlers
    document.querySelectorAll('[data-pr-remove]').forEach(btn => {
      btn.addEventListener('click', () => btn.closest('.pr-row')?.remove());
    });

    // Form submits
    wireForm('form-basics',     () => collectBasics(),     preview, slug);
    wireForm('form-positioning',() => collectPositioning(),preview, slug);
    wireForm('form-ratings',    () => collectRatings(),    preview, slug);
    wireForm('form-quotes',     () => collectQuotes(),     preview, slug);
    wireForm('form-ops',        () => collectOps(),        preview, slug);

    // "+ Add another quote" — extends the quotes list one entry at a time
    // so the form grows with the tenant's testimonial pile rather than
    // forcing a fixed count.
    // AI score check on BusinessProfile.
    // - Page load: GET /api/client/profile-score (no API spend) →
    //   shows cached score immediately if present.
    // - Manual click → POST → cache hit (instant) or fresh run.
    // - Profile saves elsewhere on the page → trigger fresh run with
    //   60s client-side debounce so a save spree doesn't cost
    //   $0.04 × 20.
    const scoreBtn = document.getElementById('btn-run-score');
    const scoreResult = document.getElementById('score-result');
    let lastScoreRunAt = 0;
    if (scoreBtn && scoreResult) {
      const af = window.AMCP && window.AMCP.authedFetch;

      async function loadCachedScore() {
        if (!af) return;
        try {
          const res = await af('/api/client/profile-score', { method: 'GET' });
          const body = await res.json().catch(() => ({}));
          if (res.ok && body.has_score) {
            scoreResult.innerHTML = renderScoreResult(body);
            scoreBtn.textContent = body.is_stale ? 'Profile changed — re-run check →' : 'Re-run check →';
          }
        } catch { /* silent */ }
      }

      window.AMCP_PROFILE_RUN_SCORE = async function (opts) {
        opts = opts || {};
        if (!af) { scoreResult.innerHTML = '<p style="color:var(--red)">Not signed in.</p>'; return; }
        // 60s debounce: rapid profile saves shouldn't burn $0.04 × N.
        if (opts.fromSave && Date.now() - lastScoreRunAt < 60_000) {
          // Still trigger a cache-read so the stale label clears once
          // the prior in-flight call returns.
          await loadCachedScore();
          return;
        }
        scoreBtn.disabled = true;
        const started = Date.now();
        lastScoreRunAt = started;
        scoreResult.innerHTML = `<div class="score-loading"><div class="score-spinner"></div><span>${opts.fromSave ? 'Profile saved — re-running AI score…' : 'Running AI score check…'} ~30-45s</span></div>`;
        const ticker = setInterval(() => {
          const elapsed = Math.round((Date.now() - started) / 1000);
          const span = scoreResult.querySelector('.score-loading span');
          if (span) span.textContent = `Running… ${elapsed}s elapsed`;
        }, 2000);
        try {
          const res = await af('/api/client/profile-score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          clearInterval(ticker);
          const body = await res.json().catch(() => ({}));
          if (!res.ok) {
            scoreResult.innerHTML = `<p style="color:var(--red);font-size:13.5px">Score check failed: ${esc(body.error || ('HTTP ' + res.status))}</p>`;
            return;
          }
          scoreResult.innerHTML = renderScoreResult(body);
          scoreBtn.textContent = 'Re-run check →';
        } catch (err) {
          clearInterval(ticker);
          scoreResult.innerHTML = `<p style="color:var(--red);font-size:13.5px">Network error: ${esc(String((err && err.message) || err))}</p>`;
        } finally {
          scoreBtn.disabled = false;
        }
      };

      scoreBtn.addEventListener('click', () => window.AMCP_PROFILE_RUN_SCORE());
      loadCachedScore();
    }

    const addQuoteBtn = document.getElementById('btn-add-quote');
    if (addQuoteBtn) {
      addQuoteBtn.addEventListener('click', () => {
        const list = document.getElementById('quotes-list');
        if (!list) return;
        const i = list.querySelectorAll('[data-quote-idx]').length;
        const sources = ["direct", "google", "yelp", "facebook", "bbb"];
        const div = document.createElement('div');
        div.innerHTML = `
          <fieldset class="ops-group" data-quote-idx="${i}">
            <legend>Quote ${i + 1}</legend>
            <div class="prof-row">
              <label>Quote
                <textarea name="quote_${i}" rows="2" maxlength="500" placeholder="What did the customer actually say?"></textarea>
              </label>
            </div>
            <div class="prof-row-2">
              <label>Author
                <input type="text" name="author_${i}" maxlength="120" placeholder="First name + last initial works (e.g. Anya R.)">
              </label>
              <label>Source
                <select name="source_${i}">
                  ${sources.map(s => `<option value="${s}">${s === 'direct' ? 'Direct (uploaded by you)' : s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
                </select>
              </label>
            </div>
          </fieldset>
        `;
        list.appendChild(div.firstElementChild);
      });
    }
  }

  function collectBasics() {
    const f = document.getElementById('form-basics');
    const svcRaw = f.description.dataset ? '' : '';  // no-op placeholder
    const services = (f.services.value || '').split(',').map(s => s.trim()).filter(Boolean);
    return {
      description:  f.description.value,
      category:     f.category.value,
      phone:        f.phone.value,
      website:      f.website.value,
      location:     f.location.value,
      referral_url: f.referral_url.value,
      services,
    };
  }
  function collectPositioning() {
    const f = document.getElementById('form-positioning');
    const csv = id => (f[id].value || '').split(',').map(s => s.trim()).filter(Boolean);
    const n = id => { const v = f[id].value.trim(); return v === '' ? null : Number(v); };
    return {
      differentiator:        f.differentiator.value,
      top_services:          csv('top_services'),
      tone:                  f.tone.value,
      pricing_tier:          f.pricing_tier.value,
      pricing:               f.pricing.value,
      years_in_business:     n('years_in_business'),
      star_rating:           n('star_rating'),
      review_count:          n('review_count'),
      service_radius_miles:  n('service_radius_miles'),
      service_area_keywords: csv('service_area_keywords'),
      certifications:        csv('certifications'),
      availability:          f.availability.value,
    };
  }
  function collectRatings() {
    const f = document.getElementById('form-ratings');
    const platforms = ["google", "yelp", "facebook", "bbb"];
    const ratings_json = {};
    for (const key of platforms) {
      const rating = parseFloat(f[`${key}_rating`].value);
      const count = parseInt(f[`${key}_count`].value, 10);
      const url = (f[`${key}_url`].value || "").trim();
      // Only include the platform if rating + count are both set.
      // url is optional but recommended.
      if (!isNaN(rating) && !isNaN(count) && rating >= 0 && rating <= 5 && count >= 0) {
        ratings_json[key] = { rating, count };
        if (url) ratings_json[key].url = url;
      }
    }
    return {
      ratings_json: Object.keys(ratings_json).length > 0 ? ratings_json : null,
    };
  }

  function collectQuotes() {
    const list = document.getElementById('quotes-list');
    const fieldsets = list.querySelectorAll('[data-quote-idx]');
    const quotes = [];
    fieldsets.forEach((fs, i) => {
      const quote  = (fs.querySelector(`[name="quote_${i}"]`)?.value  || "").trim();
      const author = (fs.querySelector(`[name="author_${i}"]`)?.value || "").trim();
      const source = (fs.querySelector(`[name="source_${i}"]`)?.value || "direct").trim();
      // Skip empty rows; only ship complete (quote + author) entries.
      if (quote && author) {
        quotes.push({ quote, author, source });
      }
    });
    return {
      customer_quotes_json: quotes.length > 0 ? quotes : null,
    };
  }

  function collectOps() {
    const f = document.getElementById('form-ops');
    const tz = f.timezone.value.trim();
    const hook = f.availability_webhook_url.value.trim();

    // hours_json from grid
    const hours_json = { emergency_24_7: !!document.getElementById('ops-emergency').checked };
    DAYS.forEach(d => {
      const cb = document.querySelector(`[data-hrs-open="${d.key}"]`);
      const o  = document.querySelector(`[data-hrs-field="${d.key}-open"]`);
      const c  = document.querySelector(`[data-hrs-field="${d.key}-close"]`);
      if (cb && cb.checked && o && c && o.value && c.value) {
        hours_json[d.key] = { open: o.value, close: c.value };
      } else {
        hours_json[d.key] = null;
      }
    });

    // pricing_json_v2 from list
    const ranges = Array.from(document.querySelectorAll('#pr-list .pr-row')).map(row => {
      const service = row.querySelector('[data-pr="service"]').value.trim();
      const minRaw  = row.querySelector('[data-pr="min"]').value.trim();
      const maxRaw  = row.querySelector('[data-pr="max"]').value.trim();
      const unit    = row.querySelector('[data-pr="unit"]').value;
      if (!service && !minRaw && !maxRaw) return null;
      return { service, min: minRaw === '' ? 0 : Number(minRaw), max: maxRaw === '' ? 0 : Number(maxRaw), unit };
    }).filter(Boolean);
    const pricing_json_v2 = {
      ranges,
      call_for_quote: !!document.getElementById('ops-cfq').checked,
      free_estimates: !!document.getElementById('ops-free-est').checked,
    };

    // lead_routing_json — only send if channel is set
    const channel = document.getElementById('ops-routing-channel').value;
    let lead_routing_json = null;
    if (channel) {
      lead_routing_json = { preferred_channel: channel };
      const ph = document.getElementById('ops-routing-phone').value.trim();
      const em = document.getElementById('ops-routing-email').value.trim();
      const fm = document.getElementById('ops-routing-form-url').value.trim();
      if (ph) lead_routing_json.phone = ph;
      if (em) lead_routing_json.email = em;
      if (fm) lead_routing_json.form_url = fm;
    }

    return {
      hours_json,
      pricing_json_v2,
      lead_routing_json,
      timezone: tz || null,
      availability_webhook_url: hook || null,
    };
  }

  function wireForm(formId, collect, preview, slug) {
    const form = document.getElementById(formId);
    if (!form) return;
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const status = form.querySelector('.prof-status');
      const btn    = form.querySelector('button[type="submit"]');
      const setStatus = (msg, kind) => {
        if (!status) return;
        status.textContent = msg || '';
        status.style.color = kind === 'error' ? 'var(--red)' : kind === 'success' ? 'var(--sage)' : 'var(--muted)';
      };
      setStatus('Saving…', 'info');
      if (btn) btn.disabled = true;

      const body = collect();

      try {
        if (preview) {
          await new Promise(r => setTimeout(r, 400));  // simulate latency
          setStatus('Saved (preview — no persistence)', 'success');
          return;
        }
        const suffix = slug ? `?slug=${encodeURIComponent(slug)}` : '';
        const res = await window.AMCP.authedFetch('/api/client/profile' + suffix, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          let msg = data && data.error ? data.error : `HTTP ${res.status}`;
          if (data && data.details && data.details.fieldErrors) {
            const first = Object.keys(data.details.fieldErrors)[0];
            if (first) msg += ` — ${first}`;
          }
          setStatus(msg, 'error');
        } else {
          setStatus('Saved', 'success');
          // Auto-rerun the AI citation score after a successful save
          // (60s debounced inside the runner). The score is only
          // legit if it reflects what AI is currently being served —
          // a save changes the rendered output, so the cached score
          // is now stale until we re-run.
          if (typeof window.AMCP_PROFILE_RUN_SCORE === 'function') {
            window.AMCP_PROFILE_RUN_SCORE({ fromSave: true });
          }
        }
      } catch (err) {
        setStatus(String(err && err.message || err), 'error');
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  function render(data) {
    const p = (data && data.profile) || {};
    return `
      <div class="plain-banner">
        <strong>In plain English:</strong>
        This is what AI tools learn about you. The fuller and more accurate it is, the more often AI picks you and the fewer corrections it needs to make.
      </div>

      <div class="row single">${renderScoreCard(p)}</div>
      <div class="row single">${renderBasicsCard(p)}</div>
      <div class="row single">${renderPositioningCard(p)}</div>
      <div class="row single">${renderRatingsCard(p)}</div>
      <div class="row single">${renderQuotesCard(p)}</div>
      <div class="row single">${renderOperationsCard(p)}</div>

      <style>
        .prof-form { display: flex; flex-direction: column; gap: 14px; margin-top: 10px; }
        .prof-form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); letter-spacing: .02em; }
        .prof-form input[type="text"], .prof-form input[type="url"], .prof-form input[type="tel"], .prof-form input[type="email"], .prof-form input[type="number"], .prof-form input[type="time"], .prof-form select, .prof-form textarea {
          font: inherit; padding: 9px 11px; border-radius: 8px;
          border: 1px solid var(--line); background: var(--paper-2);
          color: var(--ink); font-size: 14px;
        }
        .prof-form input:focus, .prof-form select:focus, .prof-form textarea:focus {
          outline: 2px solid var(--maroon); outline-offset: 1px; background: var(--paper);
        }
        .prof-form input:disabled { opacity: .6; cursor: not-allowed; }
        .prof-form textarea { resize: vertical; min-height: 60px; }
        .prof-row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .prof-row-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
        @media (max-width: 720px) { .prof-row-2, .prof-row-3 { grid-template-columns: 1fr; } }
        .prof-actions { display: flex; align-items: center; gap: 12px; margin-top: 4px; }
        .prof-status { font-size: 13px; color: var(--muted); }

        .ops-group {
          border: 1px solid var(--line); border-radius: 10px;
          padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;
          margin: 0;
        }
        .ops-group legend {
          font-size: 11px; letter-spacing: .1em; text-transform: uppercase;
          color: var(--muted); padding: 0 8px;
        }
        .hrs-row {
          display: grid; grid-template-columns: 44px 24px 1fr 1fr; gap: 10px; align-items: center;
        }
        .hrs-day { font-size: 13px; color: var(--ink-2); font-weight: 500; }
        .hrs-247 { flex-direction: row; align-items: center; gap: 8px; font-size: 13px; color: var(--ink-2) !important; }
        .hrs-247 input { flex-shrink: 0; }

        .pr-row {
          display: grid; grid-template-columns: 2fr 1fr 1fr 110px 32px; gap: 8px; align-items: center;
        }
        @media (max-width: 720px) { .pr-row { grid-template-columns: 1fr; } }
        #pr-list { display: flex; flex-direction: column; gap: 8px; }

        .prof-form code {
          background: var(--paper-2); padding: 1px 5px;
          border-radius: 4px; font-size: 12.5px; color: var(--maroon);
        }

        /* AI citation score card */
        #score-card .card-head { gap: 16px; }
        .score-loading {
          display: flex; align-items: center; gap: 10px;
          padding: 16px; color: var(--muted); font-size: 13.5px;
        }
        .score-spinner {
          width: 16px; height: 16px; border-radius: 999px;
          border: 2px solid var(--line); border-top-color: var(--maroon);
          animation: score-spin 1s linear infinite;
        }
        @keyframes score-spin { to { transform: rotate(360deg); } }
        .score-summary {
          display: grid; grid-template-columns: 200px 1fr; gap: 24px;
          align-items: center; padding: 8px 0 14px;
          border-bottom: 1px solid var(--line);
        }
        @media (max-width: 720px) { .score-summary { grid-template-columns: 1fr; } }
        .score-bigwheel {
          display: flex; flex-direction: column; align-items: center;
          justify-content: center; padding: 12px;
          background: var(--paper-2); border-radius: 12px;
        }
        .score-num {
          font-family: var(--serif); font-size: 56px; line-height: 1;
          color: var(--maroon); font-weight: 400;
        }
        .score-num-max { font-size: 24px; color: var(--muted); }
        .score-num-label { color: var(--muted); font-size: 12.5px; margin-top: 6px; }
        .score-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
        .score-table th {
          text-align: left; padding: 6px 8px;
          font-size: 11.5px; color: var(--muted); font-weight: 500;
          text-transform: uppercase; letter-spacing: .05em;
        }
        .score-table th.t, .score-table td.t { text-align: right; }
        .score-table td { padding: 8px 8px; border-top: 1px solid var(--line); }
        .score-bar { height: 6px; background: var(--line); border-radius: 999px; overflow: hidden; }
        .score-bar-fill { height: 100%; background: var(--maroon); }
        .score-improvements {
          padding: 14px 0 4px;
        }
        .score-improvements > strong {
          font-size: 13px; letter-spacing: .04em; text-transform: uppercase;
          color: var(--muted); display: block; margin-bottom: 10px;
        }
        .score-tip {
          display: grid; grid-template-columns: 56px 1fr; gap: 14px;
          padding: 12px 0; border-top: 1px solid var(--line);
        }
        .score-tip:first-of-type { border-top: 0; }
        .score-tip-lift {
          font-family: var(--serif); font-size: 22px; color: var(--sage);
          font-weight: 500; text-align: center; padding-top: 4px;
        }
        .score-tip-reason {
          font-size: 13.5px; line-height: 1.5; color: var(--ink-2);
        }
        .score-tip-link {
          display: inline-block; margin-top: 6px; color: var(--maroon);
          font-size: 13px; font-weight: 500;
        }
        .score-meta {
          margin-top: 14px; padding-top: 12px;
          border-top: 1px solid var(--line);
          font-size: 11.5px; color: var(--muted);
        }
      </style>
    `;
  }

  window.AMCP_PROFILE = { demo: () => DEMO, fetch: fetchReal, render, afterMount };
})();

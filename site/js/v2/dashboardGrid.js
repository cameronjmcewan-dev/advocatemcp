/* Dashboard card-grid renderer for /app (course-correction Apr 29 2026).
 *
 * When ?dashboardId=N is in the URL AND the user has saved layouts via
 * the /api/client/dashboards CRUD, /app.html renders this card grid
 * INSTEAD of the legacy hardcoded Overview page. The grid is
 * Profound-style: 4-col responsive, ECharts canvases per card,
 * drag-and-drop via Sortable.js (loaded inside this file via dynamic
 * <script>), and a "PDF" button on the topbar exports the grid via
 * html2pdf.js.
 *
 * The card definitions (id, label, fetch endpoint, chart kind) live in
 * window.AMCP_CARD_REGISTRY which is populated below — same shape as
 * the worker-side cards.ts so the layout_json from /api/client/
 * dashboards renders identically across both surfaces.
 *
 * Data fetch: every card reads from existing /api/client/{metrics,
 * activity,radar} endpoints. The date range applies to /metrics +
 * /activity through the worker's date-range support shipped in
 * Phase A.
 *
 * Renderers per chart-kind: kpi, line, donut, bar_horizontal, heatmap,
 * table, stacked_bar, count_list. Identical to the worker-side
 * mappings.
 */

(function () {
  'use strict';

  // Card registry mirrors worker/src/routes/dashboard/cards.ts. Update
  // both in lockstep when adding a card.
  const CARD_REGISTRY = [
    { id: 'visibilityScore',       label: 'Visibility Score',          endpoint: '/api/client/metrics',       size: 'sm', kind: 'kpi' },
    { id: 'queriesOverTime',       label: 'Queries Over Time',         endpoint: '/api/client/metrics',       size: 'lg', kind: 'line' },
    { id: 'botMix',                label: 'Crawler Mix',                endpoint: '/api/client/metrics',       size: 'md', kind: 'donut' },
    { id: 'intentDistribution',    label: 'Query Intent',               endpoint: '/api/client/metrics',       size: 'md', kind: 'donut' },
    { id: 'activityHeatmap',       label: 'Activity Heatmap',           endpoint: '/api/client/metrics',       size: 'lg', kind: 'heatmap' },
    { id: 'topQueries',            label: 'Top Queries',                endpoint: '/api/client/metrics',       size: 'md', kind: 'table' },
    { id: 'clickRate',             label: 'Referral Click-Through',     endpoint: '/api/client/metrics',       size: 'sm', kind: 'kpi' },
    { id: 'agentReputation',       label: 'Agent Reputation',           endpoint: '/api/client/activity',      size: 'md', kind: 'bar_horizontal' },
    { id: 'competitorShareOfVoice', label: 'Competitor Share of Voice', endpoint: '/api/client/radar',         size: 'lg', kind: 'line' },
    { id: 'reservationFunnel',     label: 'Reservation Funnel',         endpoint: '/api/client/activity',      size: 'md', kind: 'stacked_bar' },
  ];
  const CARDS_BY_ID = Object.fromEntries(CARD_REGISTRY.map((c) => [c.id, c]));
  window.AMCP_CARD_REGISTRY = CARD_REGISTRY;

  function sizeToSpan(size) {
    return size === 'xl' ? 4 : size === 'lg' ? 3 : size === 'md' ? 2 : 1;
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fmtInt(n) {
    if (typeof n !== 'number') return '—';
    return n.toLocaleString();
  }

  /** Resolve the date range query string (?range= or ?start_date=&end_date=)
   *  from the current URL. The picker on the topbar updates the URL on
   *  change, so this stays in sync. Default is range=30d. */
  function rangeQS() {
    const u = new URL(location.href);
    const r = u.searchParams.get('range');
    const s = u.searchParams.get('start_date');
    const e = u.searchParams.get('end_date');
    if (s && e) return 'start_date=' + encodeURIComponent(s) + '&end_date=' + encodeURIComponent(e);
    if (r) return 'range=' + encodeURIComponent(r);
    return 'range=30d';
  }

  /** Render the static card chrome (header + skeleton + mount + error
   *  states). Identical structure to worker/src/routes/dashboard/
   *  renderCard.ts so the CSS classes match across surfaces. */
  function renderCardShell(cardDef, size) {
    const span = sizeToSpan(size);
    const bodyHeight = cardDef.kind === 'kpi'           ? 'auto'
                     : cardDef.kind === 'count_list'    ? 'auto'
                     : cardDef.kind === 'table'         ? 'auto'
                     : cardDef.kind === 'heatmap'       ? '240px'
                     : '300px';
    return `<div class="card" data-card-id="${cardDef.id}"
        data-fetch-endpoint="${cardDef.endpoint}"
        data-chart-kind="${cardDef.kind}"
        style="grid-column: span ${span}">
      <div class="card-hd">
        <div class="card-title"><h3>${escHtml(cardDef.label)}</h3></div>
        <div class="card-actions">
          <button class="card-action card-remove" title="Remove" type="button">×</button>
        </div>
      </div>
      <div class="card-bd" style="min-height:${bodyHeight}">
        <div class="card-skeleton" data-card-skeleton>
          <div class="skel-bar" style="width:60%"></div>
          <div class="skel-bar" style="width:80%"></div>
          <div class="skel-bar" style="width:45%"></div>
        </div>
        <div class="card-mount" data-card-mount style="display:none;height:100%;width:100%"></div>
        <div class="card-error" data-card-error style="display:none">
          <p>Couldn't load this card.</p>
          <button class="card-retry" type="button">Retry</button>
        </div>
      </div>
    </div>`;
  }

  /** Render the full grid HTML — called once on initial mount. */
  function renderGridHtml(layout) {
    const cards = layout.map((entry) => {
      const def = CARDS_BY_ID[entry.card_id];
      if (!def) return '';
      return renderCardShell(def, entry.size);
    }).filter(Boolean).join('\n');
    return `<div id="dashboard-card-grid" class="dashboard-grid">${cards}</div>`;
  }

  /** ECharts theme — maroon-tinted palette for the /app dashboard's
   *  visual style. Pulled from styles.css tokens at boot so dark/light
   *  toggles flow through. */
  function bootTheme() {
    if (!window.echarts) return;
    const root = getComputedStyle(document.documentElement);
    const text = (root.getPropertyValue('--ink') || '#141210').trim();
    const sub  = (root.getPropertyValue('--muted') || '#766f63').trim();
    const line = (root.getPropertyValue('--line') || '#d4ccbf').trim();
    const palette = ['#7d2550', '#c87b9b', '#3a8c7c', '#d29922', '#5a7eaa', '#e07a5f'];
    window.echarts.registerTheme('advocate', {
      color: palette,
      backgroundColor: 'transparent',
      textStyle: { color: text, fontFamily: 'inherit' },
      title:    { textStyle: { color: text } },
      legend:   { textStyle: { color: sub } },
      tooltip:  { backgroundColor: 'rgba(20,18,16,.92)', borderWidth: 0, textStyle: { color: '#fff', fontSize: 12 } },
      categoryAxis: { axisLine:{ lineStyle:{ color: line } }, axisTick:{ lineStyle:{ color: line } }, axisLabel:{ color: sub }, splitLine:{ lineStyle:{ color: line } } },
      valueAxis:    { axisLine:{ lineStyle:{ color: line } }, axisTick:{ lineStyle:{ color: line } }, axisLabel:{ color: sub }, splitLine:{ lineStyle:{ color: line } } },
    });
  }

  /** Per-card renderer dispatch. Each takes the card DOM root + the
   *  fetched data + a refs bag. Hide skeleton / error and show the
   *  ECharts canvas (or KPI HTML) on success. */
  const RENDERERS = {
    kpi: renderKpi,
    line: renderLine,
    donut: renderDonut,
    bar_horizontal: renderBarHorizontal,
    heatmap: renderHeatmap,
    table: renderTable,
    stacked_bar: renderStackedBar,
  };

  function renderKpi(card, data, refs) {
    const cardId = card.dataset.cardId;
    let html = '';
    if (cardId === 'visibilityScore') {
      const inRange = (data.queries_last_30_days || []).reduce((a, b) => a + (b.count || 0), 0);
      html = `<div class="kpi-card-body">
        <div class="kpi-value">${fmtInt(inRange)}</div>
        <div class="kpi-sub">queries · last ${(data.date_range && data.date_range.days) || 30} days</div>
        <div class="kpi-sub">${fmtInt(data.total_queries)} lifetime</div>
      </div>`;
    } else if (cardId === 'clickRate') {
      const queries = (data.queries_last_30_days || []).reduce((a, b) => a + (b.count || 0), 0);
      const clicks = data.referral_clicks_last_30_days || 0;
      const rate = queries > 0 ? (clicks / queries) : 0;
      html = `<div class="kpi-card-body">
        <div class="kpi-value">${(rate * 100).toFixed(1)}%</div>
        <div class="kpi-sub">${fmtInt(clicks)} clicks · ${fmtInt(queries)} queries</div>
      </div>`;
    } else {
      html = '<div class="kpi-value">—</div>';
    }
    refs.mount.innerHTML = html;
    showMount(refs);
  }

  function renderLine(card, data, refs) {
    const cardId = card.dataset.cardId;
    refs.mount.classList.add('echarts-host');
    const inst = window.echarts.init(refs.mount, 'advocate');
    let option;
    if (cardId === 'queriesOverTime') {
      const rows = data.queries_last_30_days || [];
      option = {
        grid: { left: 40, right: 16, top: 16, bottom: 28 },
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'category', data: rows.map((r) => r.date), boundaryGap: false },
        yAxis: { type: 'value', minInterval: 1 },
        series: [{ type: 'line', data: rows.map((r) => r.count), smooth: true, showSymbol: false, areaStyle: { opacity: .15 }, lineStyle: { width: 2 } }],
      };
    } else if (cardId === 'competitorShareOfVoice') {
      const series = (data && data.series) || [];
      option = {
        grid: { left: 40, right: 16, top: 16, bottom: 28 },
        tooltip: {
          trigger: 'axis',
          formatter: (params) => {
            const p = params[0]; const raw = series[p.dataIndex] || {};
            return `${p.axisValueLabel}<br>Share: ${(p.value * 100).toFixed(1)}%<br>Cited in ${raw.cited || 0} of ${raw.polls || 0} polls`;
          }
        },
        xAxis: { type: 'category', data: series.map((r) => r.week_start), boundaryGap: false },
        yAxis: { type: 'value', max: 1, axisLabel: { formatter: (v) => (v * 100 | 0) + '%' } },
        series: [{ type: 'line', data: series.map((r) => r.share), smooth: true, showSymbol: true, symbolSize: 6, areaStyle: { opacity: .15 }, lineStyle: { width: 2 } }],
      };
    } else {
      option = {};
    }
    inst.setOption(option);
    window.addEventListener('resize', () => inst.resize());
    refs.echartsInst = inst;
    showMount(refs);
  }

  function renderDonut(card, data, refs) {
    const cardId = card.dataset.cardId;
    refs.mount.classList.add('echarts-host');
    const inst = window.echarts.init(refs.mount, 'advocate');
    const src = cardId === 'botMix' ? (data.queries_by_crawler || {}) : (data.queries_by_intent || {});
    let entries = Object.keys(src).map((k) => ({ name: k, value: src[k] }));
    if (!entries.length) entries = [{ name: 'No data', value: 1 }];
    inst.setOption({
      tooltip: { trigger: 'item' },
      legend: { orient: 'vertical', right: 0, top: 'center', textStyle: { color: 'var(--muted)' } },
      series: [{ type: 'pie', radius: ['55%', '80%'], center: ['35%', '50%'], label: { show: false }, labelLine: { show: false }, data: entries }],
    });
    window.addEventListener('resize', () => inst.resize());
    refs.echartsInst = inst;
    showMount(refs);
  }

  function renderBarHorizontal(card, data, refs) {
    refs.mount.classList.add('echarts-host');
    const inst = window.echarts.init(refs.mount, 'advocate');
    const rep = (data.agent_reputation || []).filter((r) => r.window === '7d').slice(0, 8);
    if (!rep.length) {
      refs.mount.innerHTML = '<div style="color:var(--muted);font-size:.8125rem;padding:1rem 0">No identified agents in this window.</div>';
      showMount(refs); return;
    }
    inst.setOption({
      grid: { left: 100, right: 16, top: 16, bottom: 28 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: { type: 'value', max: 1 },
      yAxis: { type: 'category', data: rep.map((r) => r.agent_id) },
      series: [{ type: 'bar', data: rep.map((r) => r.quality_score), itemStyle: { borderRadius: [0, 3, 3, 0] } }],
    });
    window.addEventListener('resize', () => inst.resize());
    refs.echartsInst = inst;
    showMount(refs);
  }

  function renderHeatmap(card, data, refs) {
    refs.mount.classList.add('echarts-host');
    const inst = window.echarts.init(refs.mount, 'advocate');
    const DOWS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const rows = data.activity_by_dow_hour || [];
    const max = rows.reduce((m, r) => Math.max(m, r.count), 0) || 1;
    const grid = rows.map((r) => [r.hour, r.dow, r.count]);
    inst.setOption({
      grid: { left: 40, right: 16, top: 16, bottom: 24 },
      tooltip: { formatter: (p) => `${DOWS[p.value[1]]} ${p.value[0]}:00 — ${p.value[2]} queries` },
      xAxis: { type: 'category', data: Array.from({ length: 24 }, (_, i) => i), splitArea: { show: true } },
      yAxis: { type: 'category', data: DOWS, splitArea: { show: true } },
      visualMap: {
        min: 0, max, calculable: false, orient: 'horizontal', left: 'center', bottom: 0,
        textStyle: { color: 'var(--muted)' },
        inRange: { color: ['rgba(125,37,80,.05)', 'rgba(125,37,80,.85)'] },
      },
      series: [{ type: 'heatmap', data: grid, label: { show: false } }],
    });
    window.addEventListener('resize', () => inst.resize());
    refs.echartsInst = inst;
    showMount(refs);
  }

  function renderTable(card, data, refs) {
    const top = data.top_queries || [];
    if (!top.length) {
      refs.mount.innerHTML = '<div style="color:var(--muted);font-size:.8125rem;padding:.5rem 0">No queries in this window.</div>';
      showMount(refs); return;
    }
    const rows = top.map((q, i) =>
      `<tr><td style="color:var(--muted);width:24px">${i + 1}</td><td>${escHtml(q)}</td></tr>`
    ).join('');
    refs.mount.innerHTML = `<table class="kpi-table"><tbody>${rows}</tbody></table>`;
    showMount(refs);
  }

  function renderStackedBar(card, data, refs) {
    refs.mount.classList.add('echarts-host');
    const inst = window.echarts.init(refs.mount, 'advocate');
    const t = (data.totals && data.totals.reservations) || { held: 0, confirmed: 0, expired: 0 };
    inst.setOption({
      grid: { left: 60, right: 16, top: 16, bottom: 28 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { textStyle: { color: 'var(--muted)' }, top: 0 },
      xAxis: { type: 'value' },
      yAxis: { type: 'category', data: ['Reservations'] },
      series: [
        { name: 'Held', type: 'bar', stack: 'r', data: [t.held || 0] },
        { name: 'Confirmed', type: 'bar', stack: 'r', data: [t.confirmed || 0] },
        { name: 'Expired', type: 'bar', stack: 'r', data: [t.expired || 0] },
      ],
    });
    window.addEventListener('resize', () => inst.resize());
    refs.echartsInst = inst;
    showMount(refs);
  }

  function showMount(refs) {
    if (refs.skeleton) refs.skeleton.style.display = 'none';
    if (refs.error) refs.error.style.display = 'none';
    refs.mount.style.display = 'block';
  }
  function showError(refs) {
    if (refs.skeleton) refs.skeleton.style.display = 'none';
    refs.mount.style.display = 'none';
    if (refs.error) refs.error.style.display = 'flex';
  }

  function loadCard(card) {
    const refs = {
      skeleton: card.querySelector('[data-card-skeleton]'),
      mount:    card.querySelector('[data-card-mount]'),
      error:    card.querySelector('[data-card-error]'),
      echartsInst: null,
    };
    const endpoint = card.dataset.fetchEndpoint;
    const sep = endpoint.indexOf('?') >= 0 ? '&' : '?';
    const url = endpoint + sep + rangeQS();
    window.AMCP.authedFetch(url)
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((data) => {
        const fn = RENDERERS[card.dataset.chartKind];
        if (!fn) throw new Error('no renderer');
        fn(card, data, refs);
      })
      .catch(() => showError(refs));
  }

  function loadAll() {
    document.querySelectorAll('.card[data-card-id]').forEach(loadCard);
  }

  /** Drag-and-drop on the card grid — Phase C from the original plan,
   *  here applied to /app. PATCHes /api/client/dashboards/:id with the
   *  new layout order. */
  function initDragDrop() {
    if (!window.Sortable) return;
    const dash = window.AMCP_DASHBOARDS;
    if (!dash || !dash.activeDashboardId) return;
    const grid = document.getElementById('dashboard-card-grid');
    if (!grid) return;
    new window.Sortable(grid, {
      animation: 150,
      handle: '.card-hd',
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      onEnd: persistLayout,
    });
  }
  function persistLayout() {
    const dash = window.AMCP_DASHBOARDS;
    if (!dash || !dash.activeDashboardId) return;
    const layout = [];
    document.querySelectorAll('#dashboard-card-grid .card[data-card-id]').forEach((el) => {
      const span = parseInt((el.style.gridColumn || '').replace(/^span\s+/, ''), 10) || 1;
      const size = span === 4 ? 'xl' : span === 3 ? 'lg' : span === 2 ? 'md' : 'sm';
      layout.push({ card_id: el.dataset.cardId, size });
    });
    window.AMCP.authedFetch('/api/client/dashboards/' + dash.activeDashboardId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout }),
    }).catch((err) => console.warn('[dashboard] persist failed', err));
  }

  /** PDF export — html2pdf.js renders the grid into a clean letter-
   *  landscape PDF. Brief 300ms wait so ECharts animations settle. */
  function exportPdf() {
    if (!window.html2pdf) { window.AMCP.toast.info('PDF library still loading', { detail: 'Try again in a moment.' }); return; }
    setTimeout(() => {
      const node = document.getElementById('dashboard-card-grid');
      if (!node) return;
      const name = ((window.AMCP_DATA && window.AMCP_DATA.business_name) || 'dashboard').replace(/[^a-z0-9-]+/gi, '-');
      const stamp = new Date().toISOString().slice(0, 10);
      window.html2pdf().set({
        margin: 0.5,
        filename: name + '-' + stamp + '.pdf',
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: '#fbf9f5' },
        jsPDF: { unit: 'in', format: 'letter', orientation: 'landscape' },
      }).from(node).save();
    }, 300);
  }

  /** Wire the topbar date-range button — open a small dropdown with
   *  the canonical 7d/30d/90d/365d/Custom options. The button text
   *  reflects the current selection. */
  function initRangePicker() {
    const btn = document.querySelector('.date-range');
    if (!btn) return;
    const u = new URL(location.href);
    const cur = u.searchParams.get('range') || (u.searchParams.get('start_date') ? 'custom' : '30d');
    const labels = { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', '365d': 'Last year', 'custom': 'Custom range' };
    btn.textContent = (labels[cur] || labels['30d']) + ' ⌄';
    btn.style.cursor = 'pointer';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Close any existing menu.
      document.querySelectorAll('.range-menu').forEach((m) => m.remove());
      const menu = document.createElement('div');
      menu.className = 'range-menu';
      menu.style.cssText = 'position:absolute;background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:4px;box-shadow:0 4px 12px rgba(0,0,0,.08);z-index:1000;min-width:160px';
      ['7d','30d','90d','365d'].forEach((opt) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.textContent = labels[opt];
        item.style.cssText = 'display:block;width:100%;text-align:left;padding:6px 10px;background:none;border:none;color:var(--ink);font-family:inherit;font-size:13px;cursor:pointer;border-radius:5px';
        item.addEventListener('mouseenter', () => item.style.background = 'var(--paper-2)');
        item.addEventListener('mouseleave', () => item.style.background = 'none');
        item.addEventListener('click', () => {
          const u2 = new URL(location.href);
          u2.searchParams.set('range', opt);
          u2.searchParams.delete('start_date');
          u2.searchParams.delete('end_date');
          window.location.href = u2.toString();
        });
        menu.appendChild(item);
      });
      const rect = btn.getBoundingClientRect();
      menu.style.top = (rect.bottom + window.scrollY + 4) + 'px';
      menu.style.left = (rect.left + window.scrollX) + 'px';
      document.body.appendChild(menu);
      const closeOnClick = (ev) => {
        if (menu.contains(ev.target)) return;
        menu.remove();
        document.removeEventListener('click', closeOnClick);
      };
      setTimeout(() => document.addEventListener('click', closeOnClick), 0);
    });
  }

  /** Inject a "PDF" action into the topbar next to the existing
   *  Share/Invite buttons. Idempotent. */
  function injectPdfButton() {
    const tbRight = document.querySelector('.tb-right') || document.querySelector('.topbar .btn-primary')?.parentElement;
    if (!tbRight || document.getElementById('amcp-pdf-export')) return;
    const btn = document.createElement('button');
    btn.id = 'amcp-pdf-export';
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-sm';
    btn.textContent = 'Export PDF';
    btn.addEventListener('click', exportPdf);
    tbRight.insertBefore(btn, tbRight.firstChild);
  }

  /** Mount the dashboard card grid into #page-content. Replaces whatever
   *  the legacy overview render put there. Returns when ECharts is ready
   *  (polled — it's loaded with `defer` from the HTML shell). */
  async function mountGrid(layout) {
    const root = document.getElementById('page-content');
    if (!root) return;
    root.innerHTML = renderGridHtml(layout);
    // Wait for ECharts to finish loading (defer'd from /app.html).
    let attempts = 0;
    while (!window.echarts && attempts++ < 50) {
      await new Promise((r) => setTimeout(r, 100));
    }
    bootTheme();
    loadAll();
    initDragDrop();
    initRangePicker();
    injectPdfButton();
  }

  window.AMCP_DASHBOARD_GRID = { mountGrid, CARD_REGISTRY };
})();

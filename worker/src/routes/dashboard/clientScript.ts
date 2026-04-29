/**
 * Client-side dashboard runtime.
 *
 * Boot sequence (in order):
 *   1. Read the server-injected `<script id="dashboard-config">` JSON blob:
 *      { slug, apiBase, range, layout, businessName }
 *   2. Wait for ECharts to load (CDN, deferred).
 *   3. For each card in the layout, find its mount point, fetch its data,
 *      and call its renderer.
 *   4. Wire up the date range picker — on change, refetch every card.
 *
 * Phase C+D add-ons (Sortable + html2pdf) live in their own helpers
 * inside this same script string so the dashboard ships exactly one
 * inline script tag.
 *
 * Apr 29 2026.
 */

/**
 * The bootScript string is concatenated into the dashboard HTML inside a
 * `<script>` tag. It runs in the browser after ECharts finishes loading.
 *
 * NOTE: This is a TS-as-string-template — all of the runtime semantics live
 * inside the template literal. Edit carefully; lint won't help with the
 * inner JS. Tested via `tsc --noEmit` on the wrapper export only.
 */
export const DASHBOARD_CLIENT_SCRIPT = `<script>
(function(){
  'use strict';

  // ── Boot config ─────────────────────────────────────────────────────────
  var configEl = document.getElementById('dashboard-config');
  if (!configEl) { console.warn('[dashboard] no config block'); return; }
  var config;
  try { config = JSON.parse(configEl.textContent || '{}'); }
  catch (e) { console.error('[dashboard] bad config json', e); return; }

  var slug      = config.slug;
  var apiBase   = config.apiBase || '';
  var rangeQS   = config.rangeQS || 'range=30d';
  var dashboardId = config.dashboardId || null;

  // ── ECharts theme ───────────────────────────────────────────────────────
  // Maps the dashboard's CSS tokens (slate/grey/blue) onto a single
  // registered theme. Reads CSS variables at boot so a dark/light toggle
  // re-application is one line: re-init the chart with the same option.
  function readVar(name, fallback){
    try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; }
    catch (e) { return fallback; }
  }
  function bootTheme(){
    if (!window.echarts) return;
    var palette = ['#60a5fa','#34d399','#fbbf24','#f87171','#a78bfa','#fb923c','#22d3ee','#f472b6'];
    var textCol = readVar('--text', '#e6edf3');
    var subCol  = readVar('--sub',  '#8b949e');
    var bdCol   = readVar('--border', '#21262d');
    window.echarts.registerTheme('advocate', {
      color: palette,
      backgroundColor: 'transparent',
      textStyle: { color: textCol, fontFamily: 'inherit' },
      title:    { textStyle: { color: textCol } },
      legend:   { textStyle: { color: subCol } },
      tooltip:  { backgroundColor: 'rgba(0,0,0,.85)', borderWidth: 0,
                  textStyle: { color: '#fff', fontSize: 12 } },
      categoryAxis: { axisLine:{ lineStyle:{ color: bdCol } },
                      axisTick:{ lineStyle:{ color: bdCol } },
                      axisLabel:{ color: subCol },
                      splitLine:{ lineStyle:{ color: bdCol } } },
      valueAxis:    { axisLine:{ lineStyle:{ color: bdCol } },
                      axisTick:{ lineStyle:{ color: bdCol } },
                      axisLabel:{ color: subCol },
                      splitLine:{ lineStyle:{ color: bdCol } } },
    });
  }

  // ── Per-card renderers ──────────────────────────────────────────────────
  // Each receives the card DOM root + the parsed JSON payload + a refs
  // bag (mountEl, skeleton, errorEl). The renderer must hide the skeleton
  // and show the mount/error.
  var RENDERERS = {
    kpi: renderKpi,
    line: renderLine,
    donut: renderDonut,
    bar_horizontal: renderBarHorizontal,
    heatmap: renderHeatmap,
    table: renderTable,
    stacked_bar: renderStackedBar,
    count_list: renderCountList,
  };

  function renderKpi(card, data, refs){
    var cardId = card.dataset.cardId;
    var html = '';
    if (cardId === 'visibilityScore'){
      var inRange = (data.queries_last_30_days || []).reduce(function(a,b){ return a + (b.count||0); }, 0);
      html = '<div class="kpi-card-body"><div class="kpi-value">' + fmtInt(inRange) + '</div>'
           + '<div class="kpi-sub">queries · last ' + (data.date_range && data.date_range.days || 30) + ' days</div>'
           + '<div class="kpi-sub">' + fmtInt(data.total_queries) + ' lifetime</div></div>';
    } else if (cardId === 'clickRate'){
      var queries = (data.queries_last_30_days || []).reduce(function(a,b){ return a + (b.count||0); }, 0);
      var clicks = data.referral_clicks_last_30_days || 0;
      var rate = queries > 0 ? (clicks / queries) : 0;
      html = '<div class="kpi-card-body"><div class="kpi-value">' + (rate * 100).toFixed(1) + '%</div>'
           + '<div class="kpi-sub">' + fmtInt(clicks) + ' clicks · ' + fmtInt(queries) + ' queries</div></div>';
    } else {
      html = '<div class="kpi-value">—</div>';
    }
    refs.mount.innerHTML = html;
    showMount(refs);
  }

  function renderLine(card, data, refs){
    var cardId = card.dataset.cardId;
    refs.mount.classList.add('echarts-host');
    var inst = window.echarts.init(refs.mount, 'advocate');
    var option;
    if (cardId === 'queriesOverTime'){
      var rows = data.queries_last_30_days || [];
      option = {
        grid: { left: 40, right: 16, top: 16, bottom: 28 },
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'category', data: rows.map(function(r){ return r.date; }), boundaryGap: false },
        yAxis: { type: 'value', minInterval: 1 },
        series: [{
          type: 'line', data: rows.map(function(r){ return r.count; }),
          smooth: true, showSymbol: false,
          areaStyle: { opacity: .15 },
          lineStyle: { width: 2 },
        }]
      };
    } else if (cardId === 'competitorShareOfVoice'){
      var series = data.series || [];
      option = {
        grid: { left: 40, right: 16, top: 16, bottom: 28 },
        tooltip: {
          trigger: 'axis',
          formatter: function(params){
            var p = params[0];
            var raw = series[p.dataIndex] || {};
            return p.axisValueLabel + '<br>'
                 + 'Share: ' + (p.value * 100).toFixed(1) + '%<br>'
                 + 'Cited in ' + (raw.cited||0) + ' of ' + (raw.polls||0) + ' polls';
          }
        },
        xAxis: { type: 'category', data: series.map(function(r){ return r.week_start; }), boundaryGap: false },
        yAxis: { type: 'value', max: 1, axisLabel: { formatter: function(v){ return (v*100|0)+'%'; } } },
        series: [{
          type: 'line', data: series.map(function(r){ return r.share; }),
          smooth: true, showSymbol: true, symbolSize: 6,
          areaStyle: { opacity: .15 }, lineStyle: { width: 2 },
        }]
      };
    } else {
      option = { title: { text: 'No data', left: 'center', top: 'middle', textStyle: { color: 'var(--muted)' } } };
    }
    inst.setOption(option);
    window.addEventListener('resize', function(){ inst.resize(); });
    refs.echartsInst = inst;
    showMount(refs);
  }

  function renderDonut(card, data, refs){
    var cardId = card.dataset.cardId;
    refs.mount.classList.add('echarts-host');
    var inst = window.echarts.init(refs.mount, 'advocate');
    var src = cardId === 'botMix' ? (data.queries_by_crawler || {}) : (data.queries_by_intent || {});
    var entries = Object.keys(src).map(function(k){ return { name: k, value: src[k] }; });
    if (!entries.length) entries = [{ name: 'No data', value: 1 }];
    inst.setOption({
      tooltip: { trigger: 'item' },
      legend: { orient: 'vertical', right: 0, top: 'center', textStyle: { color: 'var(--sub)' } },
      series: [{
        type: 'pie',
        radius: ['55%', '80%'],
        center: ['35%', '50%'],
        label: { show: false },
        labelLine: { show: false },
        data: entries,
      }]
    });
    window.addEventListener('resize', function(){ inst.resize(); });
    refs.echartsInst = inst;
    showMount(refs);
  }

  function renderBarHorizontal(card, data, refs){
    refs.mount.classList.add('echarts-host');
    var inst = window.echarts.init(refs.mount, 'advocate');
    var rep = (data.agent_reputation || []).filter(function(r){ return r.window === '7d'; }).slice(0, 8);
    if (!rep.length){
      refs.mount.innerHTML = '<div style="color:var(--muted);font-size:.8125rem;padding:1rem 0">No identified agents in this window.</div>';
      showMount(refs); return;
    }
    inst.setOption({
      grid: { left: 100, right: 16, top: 16, bottom: 28 },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: function(params){
          var p = params[0]; var r = rep[p.dataIndex];
          return '<b>' + p.axisValueLabel + '</b><br>'
               + 'Quality: ' + p.value.toFixed(2) + '<br>'
               + 'Conversion: ' + (r.conversion_rate * 100).toFixed(1) + '%<br>'
               + 'Requests: ' + r.requests;
        }
      },
      xAxis: { type: 'value', max: 1 },
      yAxis: { type: 'category', data: rep.map(function(r){ return r.agent_id; }) },
      series: [{
        type: 'bar', data: rep.map(function(r){ return r.quality_score; }),
        itemStyle: { borderRadius: [0,3,3,0] },
      }]
    });
    window.addEventListener('resize', function(){ inst.resize(); });
    refs.echartsInst = inst;
    showMount(refs);
  }

  function renderHeatmap(card, data, refs){
    refs.mount.classList.add('echarts-host');
    var inst = window.echarts.init(refs.mount, 'advocate');
    var DOWS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var rows = data.activity_by_dow_hour || [];
    var max = rows.reduce(function(m,r){ return Math.max(m, r.count); }, 0) || 1;
    var grid = rows.map(function(r){ return [r.hour, r.dow, r.count]; });
    inst.setOption({
      grid: { left: 40, right: 16, top: 16, bottom: 24 },
      tooltip: {
        formatter: function(p){
          return DOWS[p.value[1]] + ' ' + p.value[0] + ':00 — ' + p.value[2] + ' queries';
        }
      },
      xAxis: { type: 'category', data: Array.from({length:24},function(_,i){ return i; }), splitArea: { show: true } },
      yAxis: { type: 'category', data: DOWS, splitArea: { show: true } },
      visualMap: {
        min: 0, max: max, calculable: false, orient: 'horizontal', left: 'center', bottom: 0,
        textStyle: { color: 'var(--sub)' },
        inRange: { color: ['rgba(96,165,250,.05)', 'rgba(96,165,250,.85)'] },
      },
      series: [{
        type: 'heatmap', data: grid,
        label: { show: false },
        emphasis: { itemStyle: { borderColor: 'var(--text)', borderWidth: 1 } },
      }]
    });
    window.addEventListener('resize', function(){ inst.resize(); });
    refs.echartsInst = inst;
    showMount(refs);
  }

  function renderTable(card, data, refs){
    var top = data.top_queries || [];
    if (!top.length){
      refs.mount.innerHTML = '<div style="color:var(--muted);font-size:.8125rem;padding:.5rem 0">No queries in this window.</div>';
      showMount(refs); return;
    }
    var rows = top.map(function(q,i){
      return '<tr><td style="color:var(--muted);width:24px">' + (i+1) + '</td><td>' + escHtml(q) + '</td></tr>';
    }).join('');
    refs.mount.innerHTML = '<table class="kpi-table"><tbody>' + rows + '</tbody></table>';
    showMount(refs);
  }

  function renderStackedBar(card, data, refs){
    refs.mount.classList.add('echarts-host');
    var inst = window.echarts.init(refs.mount, 'advocate');
    var t = data.totals && data.totals.reservations || { held: 0, confirmed: 0, expired: 0 };
    inst.setOption({
      grid: { left: 60, right: 16, top: 16, bottom: 28 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { textStyle: { color: 'var(--sub)' }, top: 0 },
      xAxis: { type: 'value' },
      yAxis: { type: 'category', data: ['Reservations'] },
      series: [
        { name: 'Held',      type: 'bar', stack: 'r', data: [t.held || 0]      },
        { name: 'Confirmed', type: 'bar', stack: 'r', data: [t.confirmed || 0] },
        { name: 'Expired',   type: 'bar', stack: 'r', data: [t.expired || 0]   },
      ]
    });
    window.addEventListener('resize', function(){ inst.resize(); });
    refs.echartsInst = inst;
    showMount(refs);
  }

  function renderCountList(card, data, refs){
    var n = (data && data.count) || 0;
    var items = data && data.items || [];
    var list = items.slice(0, 5).map(function(it){
      return '<div style="font-size:.75rem;color:var(--sub);padding:.125rem 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escHtml(it.path || it.title || it.url || '') + '</div>';
    }).join('');
    refs.mount.innerHTML = '<div class="kpi-card-body"><div class="kpi-value">' + fmtInt(n) + '</div>'
      + '<div class="kpi-sub">live</div>'
      + (list ? '<div style="margin-top:.5rem;border-top:1px solid var(--border);padding-top:.5rem">' + list + '</div>' : '')
      + '</div>';
    showMount(refs);
  }

  // ── Card lifecycle ──────────────────────────────────────────────────────
  function showMount(refs){
    if (refs.skeleton) refs.skeleton.style.display = 'none';
    if (refs.error) refs.error.style.display = 'none';
    refs.mount.style.display = 'block';
  }
  function showError(refs){
    if (refs.skeleton) refs.skeleton.style.display = 'none';
    refs.mount.style.display = 'none';
    if (refs.error) refs.error.style.display = 'flex';
  }
  function showSkeleton(refs){
    if (refs.skeleton) refs.skeleton.style.display = 'flex';
    if (refs.mount) refs.mount.style.display = 'none';
    if (refs.error) refs.error.style.display = 'none';
    if (refs.echartsInst){ try{ refs.echartsInst.dispose(); }catch(_){} refs.echartsInst = null; }
    if (refs.mount) refs.mount.innerHTML = '';
  }

  function loadCard(card){
    var refs = {
      skeleton: card.querySelector('[data-card-skeleton]'),
      mount:    card.querySelector('[data-card-mount]'),
      error:    card.querySelector('[data-card-error]'),
      echartsInst: null,
    };
    showSkeleton(refs);
    var endpoint = (card.dataset.fetchEndpoint || '').replace(':slug', encodeURIComponent(slug));
    var sep = endpoint.indexOf('?') >= 0 ? '&' : '?';
    var url = apiBase + endpoint + sep + rangeQS;
    fetch(url, { credentials: 'include' })
      .then(function(r){ if (!r.ok) throw new Error('fetch ' + r.status); return r.json(); })
      .then(function(data){
        var kind = card.dataset.chartKind;
        var fn = RENDERERS[kind];
        if (!fn){ throw new Error('no renderer for ' + kind); }
        fn(card, data, refs);
      })
      .catch(function(err){
        console.error('[dashboard] card load failed', card.dataset.cardId, err);
        showError(refs);
      });
    if (refs.error){
      var retry = refs.error.querySelector('.card-retry');
      if (retry) retry.onclick = function(){ loadCard(card); };
    }
  }

  function loadAll(){
    document.querySelectorAll('.card[data-card-id]').forEach(loadCard);
  }

  // ── Date range picker ───────────────────────────────────────────────────
  function initRangePicker(){
    var picker = document.getElementById('range-picker');
    if (!picker) return;
    picker.addEventListener('change', function(){
      var v = picker.value;
      if (v === 'custom'){
        var custom = document.getElementById('range-custom');
        if (custom) custom.style.display = 'flex';
        return;
      }
      var custom = document.getElementById('range-custom');
      if (custom) custom.style.display = 'none';
      rangeQS = 'range=' + encodeURIComponent(v);
      // Update URL so reloads keep state.
      var u = new URL(window.location.href);
      u.searchParams.delete('start_date');
      u.searchParams.delete('end_date');
      u.searchParams.set('range', v);
      window.history.replaceState(null, '', u.toString());
      loadAll();
    });
    var apply = document.getElementById('range-apply');
    if (apply){
      apply.addEventListener('click', function(){
        var s = document.getElementById('range-start').value;
        var e = document.getElementById('range-end').value;
        if (!s || !e) return;
        rangeQS = 'start_date=' + encodeURIComponent(s) + '&end_date=' + encodeURIComponent(e);
        var u = new URL(window.location.href);
        u.searchParams.delete('range');
        u.searchParams.set('start_date', s);
        u.searchParams.set('end_date', e);
        window.history.replaceState(null, '', u.toString());
        loadAll();
      });
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────
  function fmtInt(n){
    if (typeof n !== 'number') return '—';
    return n.toLocaleString();
  }
  function escHtml(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Boot ────────────────────────────────────────────────────────────────
  function boot(){
    bootTheme();
    initRangePicker();
    loadAll();
  }
  if (window.echarts) {
    boot();
  } else {
    // ECharts is loaded with the defer attribute, so it may finish after DOMContentLoaded.
    var attempts = 0;
    var pollId = setInterval(function(){
      if (window.echarts){ clearInterval(pollId); boot(); }
      else if (++attempts > 50){ clearInterval(pollId); console.error('[dashboard] echarts never loaded'); }
    }, 100);
  }
})();
</script>`;

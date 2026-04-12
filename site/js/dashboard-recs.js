/* Recommendations section — data-driven rec cards + optimization checklist.
 * Registers as window.AMCP_SECTIONS['recommendations']. */
(function () {
  'use strict';

  var rendered = false;

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* Static rec cards — each has a condition function and content */
  var REC_CARDS = [
    {
      title: 'Respond to Emergency Queries',
      body:  'You\'re getting emergency-intent queries. Make sure your phone number and hours are prominent in your Advocate profile so AI answers include immediate contact info.',
      show:  function (d) { return (d.queries_by_intent && d.queries_by_intent['emergency'] > 0); },
    },
    {
      title: 'Lean into "Best Of" Positioning',
      body:  'Best/top queries are common for your category. Add awards, certifications, or a star rating to your profile to boost citation in ranking-style AI answers.',
      show:  function (d) { return (d.queries_by_intent && (d.queries_by_intent['best_top'] || 0) > 0); },
    },
    {
      title: 'Optimize for Affordable Seekers',
      body:  'A portion of your queries are price-sensitive. Consider adding a pricing tier or a "free estimate" CTA to your referral URL to convert affordable-intent clicks.',
      show:  function (d) { return (d.queries_by_intent && (d.queries_by_intent['affordable'] || 0) > 0); },
    },
    {
      title: 'Expand Your Service Description',
      body:  'Specific-service queries are landing on your profile. Add more detail about individual services so AI answers can match narrow queries more precisely.',
      show:  function (d) { return (d.queries_by_intent && (d.queries_by_intent['specific_service'] || 0) > 0); },
    },
    {
      title: 'Improve Referral Click Rate',
      body:  'Your click-through rate has room to grow. Try updating your referral URL to a high-intent landing page (e.g. a contact form or booking page) rather than your homepage.',
      show:  function (d) {
        if (typeof d.total_queries !== 'number' || d.total_queries === 0) return false;
        return (d.referral_clicks / d.total_queries) < 0.05;
      },
    },
    {
      title: 'Activate More AI Crawlers',
      body:  'You\'re visible to some AI bots but not all. Perplexity, ChatGPT, and Google AI are the highest-traffic sources. Ensure your domain is reachable and your sitemap is current.',
      show:  function (d) { return Object.keys(d.queries_by_crawler || {}).length < 3; },
    },
  ];

  /* Always-visible checklist items */
  var CHECKLIST = [
    { text: 'Business profile complete (name, description, services)', done: true },
    { text: 'Referral URL set to a conversion page (not homepage)', done: false },
    { text: 'Receiving traffic from at least 2 AI bots',
      doneCheck: function (d) { return Object.keys(d.queries_by_crawler || {}).length >= 2; } },
    { text: 'At least 1 referral click recorded',
      doneCheck: function (d) { return (d.referral_clicks || 0) >= 1; } },
    { text: 'Response tone set to match your brand voice', done: true },
  ];

  function checkItem(item, data) {
    if (typeof item.doneCheck === 'function') return item.doneCheck(data);
    return !!item.done;
  }

  function renderRecs(data) {
    var grid = document.getElementById('rec-grid');
    if (!grid) return;
    var active = REC_CARDS.filter(function (c) { return c.show(data); }).slice(0, 4);
    if (!active.length) {
      grid.innerHTML = '<div class="db-card" style="grid-column:1/-1">' +
        '<div class="empty">' +
        '<div class="empty-icon"><i data-lucide="check-circle"></i></div>' +
        '<div class="empty-title">All good!</div>' +
        '<div class="empty-desc">Keep monitoring your dashboard as traffic grows.</div>' +
        '</div></div>';
      return;
    }
    grid.innerHTML = active.map(function (c) {
      return '<div class="rec-card">' +
        '<div class="rec-card-title">' +
          '<div class="rec-icon"><i data-lucide="lightbulb"></i></div>' +
          esc(c.title) +
        '</div>' +
        '<div class="rec-card-body">' + esc(c.body) + '</div>' +
        '</div>';
    }).join('');
  }

  function renderChecklist(data) {
    var wrap = document.getElementById('checklist');
    if (!wrap) return;
    wrap.innerHTML = CHECKLIST.map(function (item) {
      var done = checkItem(item, data);
      return '<div class="check-item">' +
        '<div class="check-dot ' + (done ? 'check-dot-done' : 'check-dot-pend') + '">' +
          (done ? '<i data-lucide="check"></i>' : '') +
        '</div>' +
        '<span style="' + (done ? '' : 'color:var(--muted)') + '">' + esc(item.text) + '</span>' +
        '</div>';
    }).join('');
  }

  function render() {
    if (rendered) return;
    var data = window.AMCP_DATA;
    if (!data) return;

    var safeData = typeof data.total_queries === 'number' ? data : {
      total_queries: 0, referral_clicks: 0,
      queries_by_crawler: {}, queries_by_intent: {},
    };

    rendered = true;
    renderRecs(safeData);
    renderChecklist(safeData);
    if (window.lucide) lucide.createIcons();
  }

  window.AMCP_SECTIONS = window.AMCP_SECTIONS || {};
  window.AMCP_SECTIONS['recommendations'] = render;
})();

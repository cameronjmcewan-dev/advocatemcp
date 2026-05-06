/* Spotlight tutorial, lives on /app.html only */
(function () {
  const STEPS = [
    { sels: ['.sb-biz', '.tb-left'], title: 'Your business',
      body: 'This is the business you\'re viewing. If you have more than one location, tap here to switch between them.' },
    { sels: ['[data-tour="kpis"]'], title: 'Your three headline numbers',
      body: '<strong>Mentions</strong> is how many times AI brought you up. <strong>Click-throughs</strong> is how many people then visited your website. <strong>Earned</strong> is the money those visits brought in.' },
    { sels: ['.date-range'], title: 'Change the date range',
      body: 'By default you\'re looking at the last 7 days. Tap here to see this month, last month, or a custom range.' },
    { sels: ['[data-tour="mentions"]'], title: 'Which AI tools are talking about you',
      body: 'The chart shows daily mentions across all AI tools. The list on the right breaks it down by tool.' },
    { sels: ['[data-tour="mentions-table"]'], title: 'Every mention, explained',
      body: 'Each row is one time AI brought up your business. The last column shows what happened next.' },
    { sels: ['[data-tour="revenue"]'], title: 'Real dollars, real bookings',
      body: 'Revenue attribution shows exactly how much money came from AI-sourced visits.' },
    { sels: ['#fab-btn'], title: 'Forget something?',
      body: 'The "?" button in the bottom-right reopens this tour anytime, explains any number on the page, or books you a support call.' },
  ];

  const overlay = document.getElementById('spot-overlay');
  const tooltip = document.getElementById('spot-tooltip');
  const countEl = document.getElementById('spot-count');
  const titleEl = document.getElementById('spot-title');
  const bodyEl = document.getElementById('spot-body');
  const dotsEl = document.getElementById('spot-dots');
  const backBtn = document.getElementById('spot-back');
  const nextBtn = document.getElementById('spot-next');
  const skipBtn = document.getElementById('spot-skip');
  let idx = 0, active = false;

  function rectsOverlap(a, b) {
    return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
  }

  function placeTooltip(primary, allRects) {
    const gap = 40, edge = 20;
    const vw = window.innerWidth, vh = window.innerHeight;
    const ttW = 340, ttH = tooltip.offsetHeight || 240;
    const targets = allRects && allRects.length ? allRects : [primary];

    function cand(side, a) {
      let top, left;
      if (side === 'right') { left = a.right + gap; top = a.top + a.height/2 - ttH/2; }
      else if (side === 'left') { left = a.left - gap - ttW; top = a.top + a.height/2 - ttH/2; }
      else if (side === 'below') { top = a.bottom + gap; left = a.left + a.width/2 - ttW/2; }
      else { top = a.top - gap - ttH; left = a.left + a.width/2 - ttW/2; }
      top = Math.max(edge, Math.min(vh - ttH - edge, top));
      left = Math.max(edge, Math.min(vw - ttW - edge, left));
      return { top, left, right: left + ttW, bottom: top + ttH, width: ttW, height: ttH };
    }
    function fits(c) { return c.left >= edge && c.top >= edge && c.right <= vw - edge && c.bottom <= vh - edge; }
    function clears(c) {
      const pad = 12;
      return targets.every(r => !rectsOverlap(c, { left: r.left - pad, right: r.right + pad, top: r.top - pad, bottom: r.bottom + pad }));
    }
    const spaces = { right: vw - primary.right, left: primary.left, below: vh - primary.bottom, above: primary.top };
    const sides = ['right','left','below','above'].sort((a,b) => spaces[b] - spaces[a]);
    let chosen = null, chosenSide = null;
    for (const s of sides) { const c = cand(s, primary); if (fits(c) && clears(c)) { chosen = c; chosenSide = s; break; } }
    if (!chosen) {
      for (const s of sides) {
        const base = cand(s, primary);
        const horiz = (s === 'above' || s === 'below');
        const range = horiz ? vw : vh;
        for (let shift = 0; shift < range; shift += 20) {
          for (const dir of [1, -1]) {
            const c = { top: base.top + (horiz ? 0 : dir * shift), left: base.left + (horiz ? dir * shift : 0) };
            c.right = c.left + ttW; c.bottom = c.top + ttH; c.width = ttW; c.height = ttH;
            if (c.left < edge || c.top < edge || c.right > vw - edge || c.bottom > vh - edge) continue;
            if (clears(c)) { chosen = c; chosenSide = s; break; }
          }
          if (chosen) break;
        }
        if (chosen) break;
      }
    }
    if (!chosen) {
      chosen = { top: edge, left: vw - ttW - edge, right: vw - edge, bottom: edge + ttH, width: ttW, height: ttH };
      chosenSide = 'above';
    }
    tooltip.style.top = chosen.top + 'px';
    tooltip.style.left = chosen.left + 'px';
    void tooltip.offsetHeight;
    return { top: chosen.top, left: chosen.left, ttW, ttH, side: chosenSide };
  }

  function drawConnector(rect, p) {
    const svg = document.getElementById('spot-connector');
    const path = document.getElementById('spot-path');
    const start = document.getElementById('spot-start');
    const end = document.getElementById('spot-end');
    const vw = window.innerWidth, vh = window.innerHeight;
    svg.setAttribute('width', vw); svg.setAttribute('height', vh); svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
    const { top, left, ttW, ttH, side } = p;
    let tx, ty, px, py;
    if (side === 'right') { tx = rect.right; ty = rect.top + rect.height/2; px = left; py = top + ttH/2; }
    else if (side === 'left') { tx = rect.left; ty = rect.top + rect.height/2; px = left + ttW; py = top + ttH/2; }
    else if (side === 'below') { tx = rect.left + rect.width/2; ty = rect.bottom; px = left + ttW/2; py = top; }
    else { tx = rect.left + rect.width/2; ty = rect.top; px = left + ttW/2; py = top + ttH; }
    const dx = px - tx, dy = py - ty;
    let c1x, c1y, c2x, c2y;
    if (side === 'right' || side === 'left') { const h = dx/2; c1x = tx + h; c1y = ty; c2x = px - h; c2y = py; }
    else { const h = dy/2; c1x = tx; c1y = ty + h; c2x = px; c2y = py - h; }
    path.setAttribute('d', `M ${tx} ${ty} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${px} ${py}`);
    start.setAttribute('cx', tx); start.setAttribute('cy', ty);
    end.setAttribute('cx', px); end.setAttribute('cy', py);
  }

  function highlight(i) {
    idx = i;
    const step = STEPS[i];
    const targets = step.sels.map(s => document.querySelector(s)).filter(Boolean);
    if (!targets.length) return;
    const primary = targets[0];

    // Scroll
    const wasLocked = document.body.style.overflow === 'hidden';
    if (wasLocked) { document.body.style.overflow = ''; document.documentElement.style.overflow = ''; }
    const vhNow = window.innerHeight;
    const primaryH = primary.getBoundingClientRect().height;
    const isTall = primaryH > vhNow * 0.45;
    const isLargeRow = primary.matches('[data-tour="kpis"], [data-tour="mentions"], [data-tour="mentions-table"], [data-tour="revenue"]');
    if (isTall || isLargeRow) {
      const absTop = primary.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: Math.max(0, absTop - 80), behavior: 'smooth' });
    } else {
      primary.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    setTimeout(() => {
      const pad = 8;
      const rects = targets.map(t => t.getBoundingClientRect());
      const vw = window.innerWidth, vh = window.innerHeight;
      const svg = document.getElementById('spot-overlay');
      svg.setAttribute('width', vw); svg.setAttribute('height', vh); svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
      document.getElementById('spot-mask-bg').setAttribute('width', vw);
      document.getElementById('spot-mask-bg').setAttribute('height', vh);
      document.getElementById('spot-dim-rect').setAttribute('width', vw);
      document.getElementById('spot-dim-rect').setAttribute('height', vh);

      const ringEls = [document.getElementById('spot-cut'), document.getElementById('spot-cut-2')];
      ringEls.forEach((ring, k) => {
        if (k < rects.length) {
          const r = rects[k];
          Object.assign(ring.style, { display: 'block', top: (r.top - pad) + 'px', left: (r.left - pad) + 'px', width: (r.width + pad*2) + 'px', height: (r.height + pad*2) + 'px' });
        } else { ring.style.display = 'none'; }
      });

      const holes = document.getElementById('spot-mask-holes');
      const existing = holes.querySelectorAll('rect');
      for (let k = 0; k < rects.length; k++) {
        const r = rects[k];
        let node = existing[k];
        if (!node) {
          node = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          node.setAttribute('fill', 'black'); node.setAttribute('rx', '12'); node.setAttribute('ry', '12');
          holes.appendChild(node);
        }
        node.setAttribute('x', r.left - pad); node.setAttribute('y', r.top - pad);
        node.setAttribute('width', r.width + pad*2); node.setAttribute('height', r.height + pad*2);
      }
      for (let k = rects.length; k < existing.length; k++) existing[k].remove();

      countEl.textContent = `Step ${i + 1} of ${STEPS.length}`;
      titleEl.textContent = step.title;
      bodyEl.innerHTML = step.body;
      dotsEl.innerHTML = STEPS.map((_, j) => `<span class="${j === i ? 'active' : ''}"></span>`).join('');
      backBtn.disabled = i === 0; backBtn.style.opacity = i === 0 ? 0.4 : 1;
      nextBtn.textContent = i === STEPS.length - 1 ? 'Finish' : 'Next →';

      const p = placeTooltip(rects[0], rects);
      requestAnimationFrame(() => {
        const p2 = placeTooltip(rects[0], rects);
        drawConnector(rects[0], p2);
      });

      if (active) { document.body.style.overflow = 'hidden'; document.documentElement.style.overflow = 'hidden'; }
    }, 350);
  }

  function startTour() {
    active = true;
    document.body.style.overflow = 'hidden'; document.documentElement.style.overflow = 'hidden';
    overlay.classList.add('active');
    highlight(0);
  }
  window.__startTour = startTour;

  function endTour() {
    active = false;
    document.body.style.overflow = ''; document.documentElement.style.overflow = '';
    overlay.classList.remove('active');
    const path = document.getElementById('spot-path');
    if (path) path.setAttribute('d', '');
    localStorage.setItem('advocate-tour-seen', '1');
  }

  nextBtn.addEventListener('click', () => { if (idx < STEPS.length - 1) highlight(idx + 1); else endTour(); });
  backBtn.addEventListener('click', () => { if (idx > 0) highlight(idx - 1); });
  skipBtn.addEventListener('click', endTour);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) endTour(); });
  window.addEventListener('resize', () => { if (active) highlight(idx); });

  function blockScroll(e) {
    if (!active) return;
    if (tooltip.contains(e.target)) return;
    e.preventDefault();
  }
  window.addEventListener('wheel', blockScroll, { passive: false });
  window.addEventListener('touchmove', blockScroll, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (!active) return;
    const keys = ['PageUp','PageDown','Home','End','ArrowUp','ArrowDown',' ','Spacebar'];
    if (keys.includes(e.key)) { if (tooltip.contains(document.activeElement)) return; e.preventDefault(); }
  });

  const welcome = document.getElementById('welcome');
  document.getElementById('welcome-start').addEventListener('click', () => { welcome.classList.remove('open'); startTour(); });
  document.getElementById('welcome-skip').addEventListener('click', () => { welcome.classList.remove('open'); localStorage.setItem('advocate-tour-seen', '1'); });

  const params = new URLSearchParams(location.search);
  if (params.get('replay') === '1') {
    setTimeout(startTour, 300);
  } else if (!localStorage.getItem('advocate-tour-seen')) {
    setTimeout(() => welcome.classList.add('open'), 600);
  }

  const fh = document.getElementById('footer-help');
  if (fh) fh.addEventListener('click', (e) => { e.preventDefault(); startTour(); });
})();

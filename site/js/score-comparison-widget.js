/* Homepage "See the math" widget, citation-readiness score
 * distribution across one Advocate-enabled tenant and several
 * archetype non-customer SMBs.
 *
 * v2 (Apr 25 2026): expanded from 3-card layout to a 7-row
 * distribution view. The previous version had WCC + 2 baselines,
 * which read as cherry-picked. The new version shows a real spread
 * (8.5, 3.8) across realistic SMB archetypes, credibility move
 * straight out of the strategic critique. Sophisticated buyers
 * pattern-match self-graded benchmarks; the spread + linked
 * methodology page is the antidote.
 *
 * Pure client-side, no API calls, no per-visitor cost. Reads
 * /data/score-comparison.json. Refreshes when that JSON does
 * (quarterly via server/scripts/refresh-comparison-data.ts).
 */

(function () {
  const MOUNT_ID = "score-comparison-mount";
  const DATA_URL = "/data/score-comparison.json";

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* Visual horizontal bar showing where the score sits on the 0-10
   * scale. Advocate-enabled gets the maroon fill; everything else gets
   * a muted ink-2 fill so the visual hierarchy makes the contrast
   * (rather than the size of the cards). */
  function renderBar(score, max, isReal) {
    const pct = Math.max(0, Math.min(100, (score / max) * 100));
    const fill = isReal ? "var(--maroon)" : "var(--ink-2)";
    return `
      <div style="height:8px;background:var(--paper-2);border-radius:999px;overflow:hidden;border:1px solid var(--line);">
        <div style="height:100%;width:${pct}%;background:${fill};"></div>
      </div>
    `;
  }

  function renderRow(example) {
    const isReal = example.is_real_data === true;
    const dotBg = isReal ? "var(--maroon)" : "var(--ink-2)";
    const labelBg = isReal ? "var(--maroon)" : "var(--paper-2)";
    const labelColor = isReal ? "#fff" : "var(--ink-2)";
    const scoreColor = isReal ? "var(--maroon)" : "var(--ink)";
    return `
      <div class="sc-row" style="
        padding: 16px 18px;
        border: 1px solid var(--line);
        border-left: 3px solid ${dotBg};
        border-radius: 8px;
        background: var(--paper);
        ${isReal ? "border-color: var(--maroon); border-left-width: 4px; background: rgba(125,37,80,0.04);" : ""}
      ">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;">
            <span style="display:inline-flex;align-items:center;padding:3px 9px;border-radius:999px;background:${labelBg};color:${labelColor};font-size:10px;letter-spacing:.06em;text-transform:uppercase;font-weight:600;flex-shrink:0;">${esc(example.label)}</span>
            <div style="font-family:var(--serif);font-size:16px;color:var(--ink);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(example.subtitle)}</div>
          </div>
          <div style="display:flex;align-items:baseline;gap:6px;flex-shrink:0;">
            <span style="font-family:var(--serif);font-size:28px;font-weight:400;line-height:1;color:${scoreColor};">${example.score.toFixed(1)}</span>
            <span style="font-size:12px;color:var(--muted);">/ ${example.score_max}</span>
          </div>
        </div>
        ${renderBar(example.score, example.score_max, isReal)}
        <div style="margin-top:10px;font-size:12.5px;color:var(--ink-2);line-height:1.5;">
          <span style="color:var(--muted);font-size:11px;letter-spacing:.06em;text-transform:uppercase;font-weight:600;">${esc(example.category || "")}</span>
          <span style="color:var(--muted);"> · </span>
          <span style="font-style:italic;">"${esc(example.judge_excerpt)}"</span>
        </div>
      </div>
    `;
  }

  function renderWidget(data) {
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;
    if (!data.examples || data.examples.length === 0) {
      mount.style.display = "none";
      return;
    }
    // Sort by score descending. Visible distribution > arbitrary order.
    const rows = [...data.examples].sort((a, b) => b.score - a.score);
    const generatedDate = new Date(data.generated_at_utc).toLocaleDateString("en-US", {
      month: "short", year: "numeric",
    });
    const advocateScore = (rows.find((r) => r.is_real_data) || {}).score;
    const otherMax = Math.max(...rows.filter((r) => !r.is_real_data).map((r) => r.score));
    const gap = advocateScore && otherMax ? (advocateScore - otherMax).toFixed(1) : null;

    mount.innerHTML = `
      <div class="container" style="max-width:920px;">
        <div style="max-width:680px;margin-bottom:22px;">
          <span class="eyebrow">See the math</span>
          <h2 style="font-family:var(--serif);font-weight:400;font-size:32px;line-height:1.15;margin:8px 0 12px;color:var(--ink);">Citation-readiness, measured.</h2>
          <p style="margin:0;font-size:14.5px;line-height:1.55;color:var(--ink-2);">
            One Advocate-enabled tenant alongside six anonymized SMB archetypes. Same Claude-judge harness, same rubric, same prompt. ${gap ? `Advocate's WCC scores ${gap} points above the strongest non-customer archetype.` : ""} The full prompt + rubric is published on <a href="/methodology.html" style="color:var(--maroon);">/methodology.html</a> so you can reproduce against your own site.
          </p>
        </div>
        <div class="sc-stack" style="display:flex;flex-direction:column;gap:10px;">
          ${rows.map(renderRow).join("")}
        </div>
        <div style="margin-top:18px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;font-size:12.5px;color:var(--muted);">
          <span>Refreshed ${esc(generatedDate)} · <a href="/methodology.html" style="color:var(--maroon);">harness prompt + rubric &rarr;</a></span>
          <a href="/Pricing.html" class="btn btn-primary btn-sm">Get this for your business &rarr;</a>
        </div>
      </div>
    `;
  }

  async function init() {
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;
    try {
      const res = await fetch(DATA_URL, { cache: "default" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      renderWidget(data);
    } catch (err) {
      mount.style.display = "none";
      if (typeof console !== "undefined" && console.warn) {
        console.warn("[score-comparison] failed to load:", err);
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

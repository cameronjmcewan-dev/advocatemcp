/* Homepage "See the math" widget — predicted citation rating
 * comparison: with-Advocate vs baseline.
 *
 * Reads pre-computed JSON from /data/score-comparison.json. Pure
 * client-side, no API calls, no per-visitor cost. The data is real:
 * Workman Copy Co.'s actual harness output for the with-Advocate panel,
 * synthesized typical sites for the baselines (with that explicitly
 * labeled). Refresh quarterly via server/scripts/refresh-comparison-data.ts.
 *
 * Mounts under #score-comparison-mount on /index.html if present.
 * Silent no-op otherwise (other pages don't need the widget).
 */

(function () {
  const MOUNT_ID = "score-comparison-mount";
  const DATA_URL = "/data/score-comparison.json";

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function pctRate(rate) {
    if (typeof rate !== "number" || !isFinite(rate)) return "—";
    return `${Math.round(rate * 100)}%`;
  }

  function renderCard(example) {
    const isReal = example.is_real_data === true;
    const dotColor = isReal ? "var(--maroon)" : "var(--muted)";
    const scoreColor = isReal ? "var(--maroon)" : "var(--ink-2)";
    return `
      <div class="sc-card" style="
        background: var(--paper);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 24px;
        display: flex; flex-direction: column;
        ${isReal ? "border-color: var(--maroon); border-width: 1.5px;" : ""}
      ">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <span style="display:inline-block;width:6px;height:6px;border-radius:999px;background:${dotColor};"></span>
          <span style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);font-weight:600;">${esc(example.label)}</span>
        </div>
        <div style="font-family:var(--serif);font-size:18px;color:var(--ink);margin-bottom:14px;">${esc(example.subtitle)}</div>
        <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:14px;">
          <div style="font-family:var(--serif);font-size:54px;font-weight:400;line-height:1;color:${scoreColor};">${example.score.toFixed(1)}</div>
          <div style="font-size:18px;color:var(--muted);">/ ${example.score_max}</div>
        </div>
        <div style="font-size:12.5px;color:var(--muted);margin-bottom:14px;">
          Cite rate: <strong style="color:var(--ink-2);">${pctRate(example.cite_rate)}</strong> ${isReal ? "· verified WCC config" : "· synthesized baseline"}
        </div>
        <p style="font-size:13.5px;color:var(--ink-2);line-height:1.5;margin:0 0 14px;">
          ${esc(example.description)}
        </p>
        <div style="margin-top:auto;padding-top:14px;border-top:1px solid var(--line);font-size:12.5px;color:var(--ink-2);font-style:italic;line-height:1.5;">
          <strong style="font-style:normal;color:var(--ink);display:block;margin-bottom:4px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;">Claude judge said</strong>
          "${esc(example.judge_excerpt)}"
        </div>
      </div>
    `;
  }

  function renderWidget(data) {
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;
    const advocate = data.examples.find((e) => e.id === "with_advocate");
    const baselines = data.examples.filter((e) => e.id !== "with_advocate");
    if (!advocate || baselines.length === 0) {
      mount.innerHTML = "";
      return;
    }
    const generatedDate = new Date(data.generated_at_utc).toLocaleDateString("en-US", {
      month: "short", year: "numeric",
    });
    mount.innerHTML = `
      <div class="container" style="max-width:1080px;">
        <div class="reveal" style="max-width:640px;margin-bottom:32px;">
          <span class="eyebrow">See the math</span>
          <h2 class="mt-4">What AI sees: with Advocate vs without.</h2>
          <p class="text-muted" style="margin-top:16px;font-size:15px;line-height:1.55;">
            Same Claude-judge harness we use internally to optimize per-engine output.
            The "With Advocate" panel reflects Workman Copy Co.'s real configuration.
            The two baselines are synthesized typical websites — what most local SMBs
            look like to AI today.
          </p>
        </div>
        <div class="sc-grid" style="
          display: grid;
          grid-template-columns: repeat(${1 + baselines.length}, minmax(0, 1fr));
          gap: 20px;
        ">
          ${renderCard(advocate)}
          ${baselines.map(renderCard).join("")}
        </div>
        <div style="margin-top:24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;font-size:12.5px;color:var(--muted);">
          <span>Comparison data refreshed ${esc(generatedDate)}. Methodology and harness details on <a href="/methodology.html" style="color:var(--maroon);">/methodology.html</a>.</span>
          <a href="/Pricing.html" class="btn btn-primary btn-sm">Get this for your business →</a>
        </div>
      </div>
      <style>
        @media (max-width: 880px) {
          .sc-grid { grid-template-columns: 1fr !important; }
        }
      </style>
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
      // Soft-fail: hide the mount entirely if the JSON is missing /
      // malformed. Better to show no widget than a broken one.
      mount.style.display = "none";
      // Surface for debugging in dev — silent in prod.
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

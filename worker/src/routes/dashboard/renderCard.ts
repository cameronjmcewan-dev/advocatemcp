/**
 * Per-card server-side render.
 *
 * Each card on the dashboard is a self-contained box with a header (title +
 * action buttons) and a body containing an ECharts mount point. The data
 * fetch + chart wiring runs CLIENT-SIDE inside `clientScript.ts` — this
 * module only emits the static chrome.
 *
 * Why split server vs. client:
 *   - The server can't run ECharts (no DOM), so charts must initialize
 *     in the browser anyway.
 *   - Keeping fetch + render in the client means a date-range change
 *     re-runs only the data-fetch step without re-fetching the page.
 *   - Each card carries a `data-card-id` + `data-fetch-endpoint` so the
 *     client renderer is just a registry lookup keyed on `data-card-id`.
 *
 * Apr 29 2026.
 */

import { type CardDef, type CardSize, sizeToSpan } from "./cards";

function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Render a single card's outer chrome. The ECharts canvas is bootstrapped
 * client-side from the `data-card-id` + `data-fetch-endpoint` attrs on
 * the wrapper. The body height varies by chart kind so collapsed-state
 * skeletons don't reflow when the chart loads.
 */
export function renderCard(card: CardDef, size: CardSize): string {
  const span = sizeToSpan(size);
  const bodyHeight = card.chart_kind === "kpi"           ? "auto"
                   : card.chart_kind === "count_list"    ? "auto"
                   : card.chart_kind === "table"         ? "auto"
                   : card.chart_kind === "heatmap"       ? "240px"
                   : "300px";

  return `<div class="card" data-card-id="${escAttr(card.id)}"
    data-fetch-endpoint="${escAttr(card.fetch_endpoint)}"
    data-chart-kind="${escAttr(card.chart_kind)}"
    style="grid-column: span ${span}">
  <div class="card-hd">
    <div class="card-title">
      <h3>${escText(card.label)}</h3>
      ${card.pro_only ? '<span class="pro-pill">Pro</span>' : ""}
    </div>
    <div class="card-actions">
      <button class="card-action card-config" title="Configure" type="button">⚙</button>
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

/**
 * CSS for the new card grid. Token-driven — every color comes from the
 * existing dashboard `:root` / `html.dark` tokens (slate/grey/blue),
 * NOT from the marketing-site maroon brand. The dashboard intentionally
 * keeps its own theme.
 */
export const CARD_GRID_CSS = `<style>
.dashboard-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1rem;margin-bottom:1.5rem}
@media(max-width:1100px){.dashboard-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:640px){.dashboard-grid{grid-template-columns:minmax(0,1fr)}}
.dashboard-grid .card{grid-column:span 1}

.card{background:var(--card);border:1px solid var(--border);border-radius:10px;display:flex;flex-direction:column;overflow:hidden;transition:border-color .15s,box-shadow .15s}
.card:hover{border-color:var(--border)}
.card.is-dragging{opacity:.5;cursor:grabbing}

.card-hd{padding:.75rem 1rem;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:.5rem;flex-shrink:0;cursor:grab}
.card-title{display:flex;align-items:center;gap:.5rem;min-width:0}
.card-title h3{font-size:.875rem;font-weight:600;color:var(--text);margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pro-pill{background:var(--info);color:#fff;font-size:.625rem;font-weight:600;padding:.125rem .375rem;border-radius:4px;text-transform:uppercase;letter-spacing:.04em;flex-shrink:0}
.card-actions{display:flex;gap:.25rem;flex-shrink:0}
.card-action{background:none;border:1px solid transparent;border-radius:5px;color:var(--muted);font-size:.875rem;padding:.125rem .375rem;cursor:pointer;line-height:1;transition:all .1s;font-family:inherit}
.card-action:hover{background:var(--al);color:var(--text);border-color:var(--border)}

.card-bd{padding:1rem;flex:1;position:relative}
.card-mount{font-size:.875rem;color:var(--text)}
.card-skeleton{display:flex;flex-direction:column;gap:.625rem;padding:.5rem 0}
.skel-bar{height:.75rem;background:linear-gradient(90deg,var(--al) 0%,var(--border) 50%,var(--al) 100%);background-size:200% 100%;border-radius:4px;animation:skel-shimmer 1.4s ease-in-out infinite}
@keyframes skel-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.card-error{padding:1rem;color:var(--danger);font-size:.8125rem;display:flex;flex-direction:column;align-items:flex-start;gap:.5rem}
.card-error p{margin:0}
.card-retry{background:var(--card);border:1px solid var(--border);border-radius:5px;color:var(--text);font-size:.75rem;padding:.25rem .625rem;cursor:pointer;font-family:inherit}
.card-retry:hover{background:var(--al)}

.kpi-card-body{display:flex;flex-direction:column;gap:.25rem}
.kpi-value{font-size:1.875rem;font-weight:700;color:var(--text);line-height:1;font-variant-numeric:tabular-nums}
.kpi-delta{font-size:.75rem;font-weight:500;display:inline-flex;align-items:center;gap:.25rem}
.kpi-delta.up{color:var(--success)}
.kpi-delta.down{color:var(--danger)}
.kpi-delta.flat{color:var(--muted)}
.kpi-sub{font-size:.6875rem;color:var(--muted)}

.kpi-table{width:100%;font-size:.8125rem;border-collapse:collapse}
.kpi-table th{text-align:left;color:var(--muted);font-size:.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;padding:.375rem 0;border-bottom:1px solid var(--border)}
.kpi-table td{padding:.5rem 0;border-bottom:1px solid var(--border);color:var(--text)}
.kpi-table tr:last-child td{border-bottom:none}
.kpi-table .num{text-align:right;font-variant-numeric:tabular-nums;color:var(--sub)}

.echarts-host{width:100%;height:100%;min-height:240px}

/* Drag-and-drop handles for Phase C */
.sortable-ghost{opacity:.4;background:var(--al)}
.sortable-chosen{cursor:grabbing}
</style>`;

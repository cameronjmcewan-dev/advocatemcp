/**
 * D1 orchestrator for /api/client/integrations/status. Queries D1 in
 * parallel for the per-integration facts and calls the pure aggregator
 * in integrationsStatus.ts. Lives in a separate file so the aggregator
 * stays pure-function testable (no D1 mocks needed in its tests).
 *
 * Promise.all parallelism over the per-integration lookups; per-query
 * catch falls back to "not_connected" facts so a transient hiccup on
 * one table doesn't blank the whole hub.
 */

import {
  buildIntegrationsStatus,
  type IntegrationsFacts,
  type IntegrationsStatusResponse,
  type PlanRequired,
} from "./integrationsStatus.js";

export async function fetchIntegrationsStatus(
  db: D1Database,
  biz: { slug: string; plan?: string },
): Promise<IntegrationsStatusResponse> {
  const slug = biz.slug;
  const plan: PlanRequired = (biz.plan ?? "base") as PlanRequired;

  const [ga4Row, gscRow, hubRow, sfRow, revRow, authRow, eventsRow] = await Promise.all([
    db.prepare("SELECT property_id, property_label, last_sync_at, last_sync_error FROM ga4_connections WHERE slug = ? LIMIT 1")
      .bind(slug)
      .first<{ property_id: string | null; property_label: string | null; last_sync_at: string | null; last_sync_error: string | null }>()
      .catch(() => null),
    db.prepare("SELECT site_url, last_sync_at, last_sync_error FROM gsc_connections WHERE slug = ? LIMIT 1")
      .bind(slug)
      .first<{ site_url: string | null; last_sync_at: string | null; last_sync_error: string | null }>()
      .catch(() => null),
    db.prepare("SELECT account_id, last_used_at, last_error FROM crm_connections WHERE slug = ? AND provider = 'hubspot' LIMIT 1")
      .bind(slug)
      .first<{ account_id: string | null; last_used_at: string | null; last_error: string | null }>()
      .catch(() => null),
    db.prepare("SELECT account_id, last_used_at, last_error FROM crm_connections WHERE slug = ? AND provider = 'salesforce' LIMIT 1")
      .bind(slug)
      .first<{ account_id: string | null; last_used_at: string | null; last_error: string | null }>()
      .catch(() => null),
    db.prepare("SELECT revenue_webhook_secret FROM businesses WHERE slug = ? LIMIT 1")
      .bind(slug)
      .first<{ revenue_webhook_secret: string | null }>()
      .catch(() => null),
    db.prepare("SELECT brand_keyword, google_place_id, last_synced_at, last_sync_error FROM authority_config WHERE slug = ? LIMIT 1")
      .bind(slug)
      .first<{ brand_keyword: string | null; google_place_id: string | null; last_synced_at: string | null; last_sync_error: string | null }>()
      .catch(() => null),
    db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN referrer_classification = 'ai' THEN 1 ELSE 0 END) AS ai FROM revenue_events WHERE business_slug = ?")
      .bind(slug)
      .first<{ total: number; ai: number }>()
      .catch(() => ({ total: 0, ai: 0 })),
  ]);

  const facts: IntegrationsFacts = {
    tenant: { slug, plan },
    ga4: {
      connected:        ga4Row !== null,
      property_id:      ga4Row?.property_id ?? null,
      property_label:   ga4Row?.property_label ?? null,
      last_sync_at:     ga4Row?.last_sync_at ?? null,
      last_sync_error:  ga4Row?.last_sync_error ?? null,
    },
    gsc: {
      connected:        gscRow !== null,
      site_url:         gscRow?.site_url ?? null,
      last_sync_at:     gscRow?.last_sync_at ?? null,
      last_sync_error:  gscRow?.last_sync_error ?? null,
    },
    hubspot: {
      connected:        hubRow !== null,
      account_id:       hubRow?.account_id ?? null,
      last_used_at:     hubRow?.last_used_at ?? null,
      last_error:       hubRow?.last_error ?? null,
    },
    salesforce: {
      connected:        sfRow !== null,
      account_id:       sfRow?.account_id ?? null,
      last_used_at:     sfRow?.last_used_at ?? null,
      last_error:       sfRow?.last_error ?? null,
    },
    stripe_webhook: {
      configured:       !!revRow?.revenue_webhook_secret,
      total_events:     Number(eventsRow?.total ?? 0),
      ai_events:        Number(eventsRow?.ai ?? 0),
    },
    authority: {
      configured:       !!(authRow?.brand_keyword && authRow?.google_place_id),
      brand_keyword:    authRow?.brand_keyword ?? null,
      google_place_id:  authRow?.google_place_id ?? null,
      last_synced_at:   authRow?.last_synced_at ?? null,
      last_sync_error:  authRow?.last_sync_error ?? null,
    },
  };

  return buildIntegrationsStatus(facts);
}

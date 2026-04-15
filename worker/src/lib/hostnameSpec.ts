/**
 * Canonical Cloudflare custom hostname configuration for AdvocateMCP tenants.
 *
 * This is the single source of truth for what every tenant's CF custom hostname
 * record should look like. New hostnames are created with this spec; existing
 * hostnames are reconciled toward it via reconcileHostname().
 *
 * If Cloudflare for SaaS introduces a new required field, add it here — every
 * tenant converges on next activate-call touch. No per-tenant special-casing.
 */

export interface CustomHostnameSpec {
  hostname: string;
  custom_origin_server: string;
  ssl: {
    method: "txt";
    type: "dv";
    settings: { min_tls_version: "1.2" };
  };
}

// CF SaaS custom_origin_server — where Cloudflare forwards traffic AFTER
// accepting a request on the tenant's custom hostname.
//
// This is DIFFERENT from CNAME_TARGET in worker/src/routes/domains.ts, which
// is the DNS target customers point their domain at. Both used to be
// "customers.advocatemcp.com" until we hit CF SaaS's same-account-zone
// loopback: when custom_origin_server pointed at another proxied zone on our
// own CF account, the edge refused to forward and returned 522 on every bot
// request (observed on www.workmancopyco.com, Apr 14 2026).
//
// Pointing custom_origin_server at the Worker's *.workers.dev URL escapes
// the SaaS layer cleanly — workers.dev is on the Workers Platform, not a
// SaaS zone, so CF treats it as an ordinary external origin. The Worker
// reads the cf-custom-hostname header (injected by SaaS) to recover the
// original tenant domain for BUSINESS_MAP lookup.
const ORIGIN_SERVER = "advocatemcp-worker.advocatecameron.workers.dev";

export function desiredHostnameSpec(hostname: string): CustomHostnameSpec {
  return {
    hostname,
    custom_origin_server: ORIGIN_SERVER,
    ssl: {
      method: "txt",
      type: "dv",
      settings: { min_tls_version: "1.2" },
    },
  };
}

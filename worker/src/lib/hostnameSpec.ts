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
// Must be a DNS record (A/AAAA/CNAME) within the SaaS zone (advocatemcp.com).
// CF silently rejects out-of-zone origins with verification_errors like
// "custom origin hostname does not exist on Cloudflare as a DNS record in
// your zone". workers.dev URLs fail this check — observed via diagnostic
// /admin/domains/:slug/raw on Apr 14 2026.
//
// customers.advocatemcp.com satisfies the constraint: proxied A record in
// advocatemcp.com zone, bound to the Worker Route customers.advocatemcp.com/*.
const ORIGIN_SERVER = "customers.advocatemcp.com";

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

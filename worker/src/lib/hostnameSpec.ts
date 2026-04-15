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

// Kept in sync with CNAME_TARGET in worker/src/routes/domains.ts.
// Duplicated literal (not imported) to keep this lib file free of route-layer
// dependencies. If this value changes, update domains.ts line 16 in the same
// commit.
const CNAME_TARGET = "customers.advocatemcp.com";

export function desiredHostnameSpec(hostname: string): CustomHostnameSpec {
  return {
    hostname,
    custom_origin_server: CNAME_TARGET,
    ssl: {
      method: "txt",
      type: "dv",
      settings: { min_tls_version: "1.2" },
    },
  };
}

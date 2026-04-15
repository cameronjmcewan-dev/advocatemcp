/**
 * Reconcile an existing Cloudflare custom hostname record against the declared
 * spec. Compares two fields (custom_origin_server, ssl.settings.min_tls_version);
 * PATCHes only the drifting fields. ssl.method and ssl.type are effectively
 * constants across our fleet so they are excluded from the drift check.
 *
 * Fields excluded from reconciliation (CF-owned state, not desired-state):
 *   - verification / ownership_verification status
 *   - ssl.status / ssl.certificate / ssl.validation_records
 *   - created_at, id
 *
 * The cfRequest fn is injected so tests can mock the CF API without stubbing
 * globalThis.fetch. In production, domains.ts passes its existing cfRequest.
 */

import type { Env } from "../types.js";
import type { CustomHostnameSpec } from "./hostnameSpec.js";

export type CfRequestFn = (
  env: Env,
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ ok: boolean; data: Record<string, unknown> }>;

export interface ReconcileResult {
  /** True if reconciliation completed without error (regardless of whether a PATCH was needed). */
  ok: boolean;
  /** True if a PATCH was fired. False if no drift was detected or PATCH failed. */
  patched: boolean;
  /** Field paths (in dot notation) that differed from the spec. Empty array = no drift. */
  drift: string[];
  /** CF record after reconciliation. Equals the input cfResult if no drift or on failure. */
  cfResult: Record<string, unknown>;
  /** Populated when ok === false. */
  error?: string;
}

export async function reconcileHostname(
  env: Env,
  cfResult: Record<string, unknown>,
  desired: CustomHostnameSpec,
  cfRequest: CfRequestFn,
): Promise<ReconcileResult> {
  const drift: string[] = [];
  const patchBody: Record<string, unknown> = {};

  // Field 1: custom_origin_server
  const actualOrigin = cfResult.custom_origin_server as string | undefined;
  if (actualOrigin !== desired.custom_origin_server) {
    drift.push("custom_origin_server");
    patchBody.custom_origin_server = desired.custom_origin_server;
  }

  // Field 2: ssl.settings.min_tls_version
  const actualSsl = (cfResult.ssl ?? {}) as Record<string, unknown>;
  const actualSettings = (actualSsl.settings ?? {}) as Record<string, unknown>;
  const actualTls = actualSettings.min_tls_version as string | undefined;
  if (actualTls !== desired.ssl.settings.min_tls_version) {
    drift.push("ssl.settings.min_tls_version");
    patchBody.ssl = { settings: { min_tls_version: desired.ssl.settings.min_tls_version } };
  }

  if (drift.length === 0) {
    return { ok: true, patched: false, drift: [], cfResult };
  }

  const id = cfResult.id as string | undefined;
  if (!id) {
    return {
      ok: false,
      patched: false,
      drift,
      cfResult,
      error: "reconcile failed: cfResult missing id",
    };
  }

  const patchRes = await cfRequest(env, "PATCH", `/${id}`, patchBody);
  if (!patchRes.ok) {
    const errMsg = (patchRes.data.error as string | undefined) ?? JSON.stringify(patchRes.data);
    return {
      ok: false,
      patched: false,
      drift,
      cfResult,
      error: `reconcile PATCH failed: ${errMsg}`,
    };
  }

  const updatedResult = (patchRes.data.result as Record<string, unknown>) ?? cfResult;
  return { ok: true, patched: true, drift, cfResult: updatedResult };
}

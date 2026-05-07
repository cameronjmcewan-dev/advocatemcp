/**
 * GA4-specific OAuth state — wraps the generic lib/oauthState.ts with
 * the "ga4-state:v1:" domain prefix locked in. Existing call sites
 * (ga4Oauth.ts, portal.ts:apiGA4StartLink) keep importing from this
 * file unchanged.
 *
 * Error messages are re-prefixed from "oauthState:" to "ga4State:" so
 * that cron logs and existing tests that grep for "ga4State:" continue
 * to work without modification.
 *
 * Generic version + tests live in lib/oauthState.ts.
 */

import { signState, verifyState, type OAuthStateBase } from "./oauthState";

const GA4_DOMAIN_PREFIX = "ga4-state:v1:";

export interface GA4State extends OAuthStateBase {
  slug:  string;
  nonce: string;
  ts:    number;
}

export async function signGA4State(payload: GA4State, signingKey: string): Promise<string> {
  return signState(payload, signingKey, GA4_DOMAIN_PREFIX);
}

export async function verifyGA4State(token: string, signingKey: string): Promise<GA4State> {
  try {
    return await verifyState<GA4State>(token, signingKey, GA4_DOMAIN_PREFIX);
  } catch (err) {
    // Re-prefix "oauthState:" errors to "ga4State:" for backward-compatibility
    // with cron logs and existing tests that assert on the "ga4State:" prefix.
    if (err instanceof Error && err.message.startsWith("oauthState:")) {
      throw new Error(err.message.replace("oauthState:", "ga4State:"));
    }
    throw err;
  }
}

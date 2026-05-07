/**
 * Salesforce REST API client. SOQL-based contact + opportunity fetch
 * for the LTV aggregator. Same passthrough-on-read pattern as HubSpot
 * — no contact data persisted in our D1.
 *
 * Salesforce-specific:
 * - Refresh-token flow uses login.salesforce.com but subsequent
 *   queries go to the per-tenant instance_url (stored in
 *   crm_connections.account_id).
 * - SOQL queries via GET /query?q=<URL-encoded SOQL>.
 *
 * Salesforce's data model differs from HubSpot:
 * - Contacts are tied to Accounts.
 * - Revenue lives in Opportunity.Amount where StageName='Closed Won'.
 * - We sum closed-won opportunities per contact (via
 *   OpportunityContactRole junction).
 *
 * For v1 simplicity we map "lifecycleStage='customer'" to "contact
 * has at least one closed-won opportunity." Future PR could honor
 * Lead.Status or Account.Type for nuanced lifecycle.
 */

// ── refreshSalesforceAccessToken ──────────────────────────────────────────────

/**
 * Exchange a Salesforce refresh token for a fresh access token.
 *
 * The token response always includes a fresh instance_url — Salesforce orgs
 * can migrate (e.g. sandbox → production, or org splits), so callers MUST
 * use the instance_url from this response for subsequent API calls, not the
 * one stored in D1 (which is only the seed from OAuth time).
 *
 * Errors are prefixed "salesforce:" for grep-friendly logs.
 */
export async function refreshSalesforceAccessToken(
  refreshToken: string,
  clientId:     string,
  clientSecret: string,
): Promise<{ accessToken: string; expiresIn: number; instanceUrl: string }> {
  const res = await fetch("https://login.salesforce.com/services/oauth2/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: refreshToken,
      client_id:     clientId,
      client_secret: clientSecret,
    }).toString(),
  });

  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 200);
    throw new Error(`salesforce: token refresh failed: ${res.status} ${snippet}`);
  }

  const json = (await res.json()) as {
    access_token?:  string;
    instance_url?:  string;
    expires_in?:    number;
  };

  if (!json.access_token) {
    throw new Error("salesforce: token refresh returned no access_token");
  }

  if (!json.instance_url) {
    throw new Error("salesforce: token refresh returned no instance_url");
  }

  return {
    accessToken:  json.access_token,
    expiresIn:    json.expires_in ?? 7200,
    instanceUrl:  json.instance_url,
  };
}

// ── Contact shape ─────────────────────────────────────────────────────────────

// Same shape as HubspotContact so aggregateLtv works untouched.
export interface SalesforceContact {
  id:              string;
  email:           string | null;
  createdAt:       string;         // ISO date
  lifecycleStage?: string;         // 'customer' | 'lead'
  totalRevenue?:   number;         // SUM of closed-won opportunity amounts
}

// ── fetchContactsWithRevenue ──────────────────────────────────────────────────

/**
 * Fetch Salesforce Contacts created on or after `createdAfter`, up to
 * `maxContacts`. For each contact, query closed-won Opportunity amounts
 * via OpportunityContactRole and sum into `totalRevenue`.
 *
 * lifecycleStage is mapped from revenue: contacts with at least one
 * closed-won opportunity become 'customer'; others become 'lead'. This
 * mirrors the HubSpot shape so aggregateLtv works without modification.
 *
 * v1 is O(contacts × 1 SOQL per contact) for simplicity. A future PR
 * could batch the aggregate query for high-volume orgs.
 *
 * Errors are prefixed "salesforce:" for grep-friendly logs.
 */
export async function fetchContactsWithRevenue(opts: {
  accessToken:  string;
  instanceUrl:  string;
  /** ISO date string — only contacts created on/after this are returned. */
  createdAfter: string;
  /** Hard cap on total contacts to avoid runaway queries. Default 1000. */
  maxContacts?: number;
}): Promise<SalesforceContact[]> {
  const { accessToken, instanceUrl, createdAfter, maxContacts = 1000 } = opts;

  // Strip trailing slash from instance_url to avoid double-slash in paths.
  const base = instanceUrl.replace(/\/$/, "");
  const apiBase = `${base}/services/data/v59.0`;

  // SOQL: fetch contacts ordered newest-first, bounded by maxContacts.
  // CreatedDate format: Salesforce accepts ISO-8601 e.g. 2026-01-01T00:00:00Z
  const contactSoql = [
    "SELECT Id, Email, CreatedDate",
    "FROM Contact",
    `WHERE CreatedDate >= ${formatSoqlDate(createdAfter)}`,
    "ORDER BY CreatedDate DESC",
    `LIMIT ${maxContacts}`,
  ].join(" ");

  const contactsRes = await fetch(
    `${apiBase}/query?q=${encodeURIComponent(contactSoql)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!contactsRes.ok) {
    const snippet = (await contactsRes.text()).slice(0, 200);
    throw new Error(`salesforce: contacts query failed: ${contactsRes.status} ${snippet}`);
  }

  const contactsJson = (await contactsRes.json()) as {
    records?: Array<{
      Id:          string;
      Email:       string | null;
      CreatedDate: string;
    }>;
    totalSize?: number;
    done?:      boolean;
  };

  const records = contactsJson.records ?? [];
  const contacts: SalesforceContact[] = [];

  for (const r of records) {
    if (contacts.length >= maxContacts) break;

    const revenue = await fetchContactRevenue(r.Id, accessToken, apiBase);

    contacts.push({
      id:             r.Id,
      email:          r.Email ?? null,
      // CreatedDate from Salesforce: "2026-04-15T14:23:11.000+0000" — convert to ISO.
      createdAt:      new Date(r.CreatedDate).toISOString(),
      lifecycleStage: revenue > 0 ? "customer" : "lead",
      totalRevenue:   revenue,
    });
  }

  return contacts;
}

// ── fetchContactRevenue ───────────────────────────────────────────────────────

/**
 * For a single contact, aggregate closed-won Opportunity amounts via the
 * OpportunityContactRole junction object.
 *
 * SOQL aggregate: SUM(Amount) from Opportunities linked to the contact
 * where StageName = 'Closed Won'. Returns 0 on any API error (non-fatal)
 * so a single bad contact doesn't abort the whole fetch.
 */
async function fetchContactRevenue(
  contactId:   string,
  accessToken: string,
  apiBase:     string,
): Promise<number> {
  // Aggregate query: SUM closed-won opportunity amounts for this contact.
  // OpportunityContactRole is the junction table between Contact + Opportunity.
  const soql = [
    "SELECT SUM(Amount) revenue",
    "FROM Opportunity",
    `WHERE Id IN (SELECT OpportunityId FROM OpportunityContactRole WHERE ContactId = '${contactId}')`,
    "AND StageName = 'Closed Won'",
  ].join(" ");

  const res = await fetch(
    `${apiBase}/query?q=${encodeURIComponent(soql)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!res.ok) {
    // Non-fatal — return 0 revenue if the aggregate query fails.
    return 0;
  }

  const json = (await res.json()) as {
    records?: Array<{ revenue: number | null }>;
  };

  const revenue = json.records?.[0]?.revenue ?? 0;
  return typeof revenue === "number" && !isNaN(revenue) ? revenue : 0;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Format a JS ISO date string into a SOQL date literal.
 * Salesforce SOQL WHERE clauses expect: YYYY-MM-DDTHH:MM:SSZ (no milliseconds).
 * Example: "2026-01-01T00:00:00.000Z" → "2026-01-01T00:00:00Z"
 */
function formatSoqlDate(isoDate: string): string {
  // Replace milliseconds (.000) if present, then ensure Z suffix.
  return isoDate.replace(/\.\d+Z$/, "Z").replace(/Z$/, "") + "Z";
}

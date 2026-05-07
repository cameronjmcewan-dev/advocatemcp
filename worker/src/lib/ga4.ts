/**
 * Thin TypeScript client for Google Analytics 4 APIs used by the Traffic
 * Impact feature.
 *
 * Endpoints touched:
 *   - oauth2.googleapis.com/token       — refresh access tokens
 *   - analyticsadmin.googleapis.com     — list properties (post-OAuth picker)
 *   - analyticsdata.googleapis.com      — daily session data (cron sync)
 *
 * Errors are surfaced with a `ga4:` prefix so cron logs are grep-friendly.
 * No retry logic here — the caller (cron / OAuth handler) decides retry policy.
 */

export interface GA4Property {
  propertyId: string;   // "properties/123456789"
  displayName: string;
}

export interface GA4DailyRow {
  date: string;                    // ISO YYYY-MM-DD
  source: string;
  medium: string;
  sessions: number;
  engagedSessions: number;         // count of engaged sessions
  averageSessionDuration: number;  // seconds (float)
  bounceRate: number;              // 0..1
  newUsers: number;
  totalUsers: number;              // used to derive returning = total - new
}

// ── refreshAccessToken ────────────────────────────────────────────────────────

export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 200);
    throw new Error(`ga4: refresh failed: ${res.status} ${snippet}`);
  }

  // Typed inline — avoids `any` without importing a full schema library
  const json = (await res.json()) as { access_token: string; expires_in: number };
  return { accessToken: json.access_token, expiresIn: json.expires_in };
}

// ── listProperties ────────────────────────────────────────────────────────────

export async function listProperties(accessToken: string): Promise<GA4Property[]> {
  const res = await fetch(
    "https://analyticsadmin.googleapis.com/v1beta/accountSummaries",
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!res.ok) {
    // Include body snippet so cron logs show e.g. quota / token-expired details
    // alongside the status. Truncated to 200 chars to keep log lines parseable.
    const snippet = (await res.text()).slice(0, 200);
    throw new Error(`ga4: listProperties failed: ${res.status} ${snippet}`);
  }

  // Typed inline to avoid `any`
  const json = (await res.json()) as {
    accountSummaries?: Array<{
      propertySummaries?: Array<{
        property: string;
        displayName: string;
      }>;
    }>;
  };

  const properties: GA4Property[] = [];
  for (const account of json.accountSummaries ?? []) {
    for (const prop of account.propertySummaries ?? []) {
      properties.push({
        propertyId: prop.property,
        displayName: prop.displayName,
      });
    }
  }
  return properties;
}

// ── fetchDailyGeography ───────────────────────────────────────────────────────

/**
 * Per-day per-country/city session data, broken down by source/medium so
 * downstream classifier can split AI vs Human. Separate from
 * fetchDailyTraffic so country×city cardinality doesn't blow the main
 * report's row budget.
 */
export interface GA4GeoRow {
  date:     string;   // YYYY-MM-DD
  country:  string;   // Country name as GA4 returns it
  city:     string;
  source:   string;
  medium:   string;
  sessions: number;
}

export async function fetchDailyGeography(opts: {
  propertyId:  string;
  startDate:   string;   // YYYY-MM-DD
  endDate:     string;   // YYYY-MM-DD
  accessToken: string;
}): Promise<GA4GeoRow[]> {
  const { propertyId, startDate, endDate, accessToken } = opts;

  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        dateRanges: [{ startDate, endDate }],
        dimensions: [
          { name: "date" },
          { name: "country" },
          { name: "city" },
          { name: "sessionSource" },
          { name: "sessionMedium" },
        ],
        metrics: [
          { name: "sessions" },
        ],
        limit: 100000,
      }),
    },
  );

  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 200);
    throw new Error(`ga4: runReport failed: ${res.status} ${snippet}`);
  }

  // Typed inline — GA4 Data API row shape
  const json = (await res.json()) as {
    rows?: Array<{
      dimensionValues: Array<{ value: string }>;
      metricValues: Array<{ value: string }>;
    }>;
  };

  // GA4 returns "(not set)" for dimensions it can't resolve (country/city
  // for direct/anonymous traffic, etc.). Normalize to "" so the empty-string
  // sentinel matches the column's NOT NULL DEFAULT '' AND the (slug, date,
  // country, city) PK collapses unresolvable rows into a single bucket per
  // day instead of producing both `(not set)` and other GA4 placeholder
  // variations as separate rows.
  const normalize = (v: string): string => (v === "(not set)" ? "" : v);

  const rows: GA4GeoRow[] = [];
  for (const row of json.rows ?? []) {
    const rawDate = row.dimensionValues[0].value;  // "YYYYMMDD"
    // GA4 returns dates without hyphens — insert them for ISO 8601
    const date = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
    rows.push({
      date,
      country:  normalize(row.dimensionValues[1].value),
      city:     normalize(row.dimensionValues[2].value),
      source:   row.dimensionValues[3].value,
      medium:   row.dimensionValues[4].value,
      sessions: parseInt(row.metricValues[0]?.value ?? "0", 10),
    });
  }
  return rows;
}

// ── fetchDailyTraffic ─────────────────────────────────────────────────────────

export async function fetchDailyTraffic(opts: {
  propertyId: string;
  startDate: string;   // YYYY-MM-DD
  endDate: string;     // YYYY-MM-DD
  accessToken: string;
}): Promise<GA4DailyRow[]> {
  const { propertyId, startDate, endDate, accessToken } = opts;

  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        dateRanges: [{ startDate, endDate }],
        dimensions: [
          { name: "date" },
          { name: "sessionSource" },
          { name: "sessionMedium" },
        ],
        metrics: [
          { name: "sessions" },
          { name: "engagedSessions" },
          { name: "averageSessionDuration" },
          { name: "bounceRate" },
          { name: "newUsers" },
          { name: "totalUsers" },
        ],
        limit: 100000,
      }),
    },
  );

  if (!res.ok) {
    // GA4 Data API 400/429 responses include machine-readable JSON detail
    // (quota/permission/format) — surface the first 200 chars to cron logs.
    const snippet = (await res.text()).slice(0, 200);
    throw new Error(`ga4: runReport failed: ${res.status} ${snippet}`);
  }

  // Typed inline — GA4 Data API row shape
  const json = (await res.json()) as {
    rows?: Array<{
      dimensionValues: Array<{ value: string }>;
      metricValues: Array<{ value: string }>;
    }>;
  };

  const rows: GA4DailyRow[] = [];
  for (const row of json.rows ?? []) {
    const rawDate = row.dimensionValues[0].value;  // "YYYYMMDD"
    // GA4 returns dates without hyphens — insert them for ISO 8601
    const date = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
    // Metric values arrive as strings; use safe accessors so partial GA4 responses
    // (e.g. properties with sampling) don't throw on missing indices.
    const mv = row.metricValues;
    rows.push({
      date,
      source: row.dimensionValues[1].value,
      medium: row.dimensionValues[2].value,
      sessions:               parseInt(mv[0]?.value ?? "0", 10),
      engagedSessions:        parseInt(mv[1]?.value ?? "0", 10),
      averageSessionDuration: parseFloat(mv[2]?.value ?? "0"),
      bounceRate:             parseFloat(mv[3]?.value ?? "0"),
      newUsers:               parseInt(mv[4]?.value ?? "0", 10),
      totalUsers:             parseInt(mv[5]?.value ?? "0", 10),
    });
  }
  return rows;
}

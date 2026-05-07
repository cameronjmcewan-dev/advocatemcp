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

// ── listDataStreams ───────────────────────────────────────────────────────────

/**
 * Lists GA4 web data streams for a property and returns the measurement IDs.
 * Used by the one-off admin endpoint that helps the operator find the
 * G-XXXXXXXXXX measurement ID for installing gtag.js on the marketing site
 * without forcing a manual round-trip into the Google Analytics UI.
 *
 * Endpoint: analyticsadmin.googleapis.com/v1beta/properties/{id}/dataStreams
 * Scope:    https://www.googleapis.com/auth/analytics.readonly  (already in OAuth grant)
 */
export interface GA4DataStream {
  name:           string;   // "properties/123/dataStreams/456"
  type:           string;   // "WEB_DATA_STREAM" | etc.
  displayName:    string;
  measurementId:  string | null;   // "G-XXXXXXXXXX" (web streams only)
  defaultUri:     string | null;
}

export async function listDataStreams(
  accessToken: string,
  propertyId:  string,    // "properties/532200123"
): Promise<GA4DataStream[]> {
  const url = `https://analyticsadmin.googleapis.com/v1beta/${propertyId}/dataStreams`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 200);
    throw new Error(`ga4: listDataStreams failed: ${res.status} ${snippet}`);
  }

  const json = (await res.json()) as {
    dataStreams?: Array<{
      name:        string;
      type:        string;
      displayName: string;
      webStreamData?: { measurementId?: string; defaultUri?: string };
    }>;
  };

  return (json.dataStreams ?? []).map((s) => ({
    name:          s.name,
    type:          s.type,
    displayName:   s.displayName,
    measurementId: s.webStreamData?.measurementId ?? null,
    defaultUri:    s.webStreamData?.defaultUri    ?? null,
  }));
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

// ── fetchDailyConversions ─────────────────────────────────────────────────────

/**
 * Per-day per-event conversion data from GA4 key_events. Pulled
 * separately from fetchDailyTraffic so the dimensions don't blow the
 * main report's row budget when the tenant has many event types.
 *
 * GA4 returns ALL events in the property — not just key_events —
 * so we filter to keyEvents > 0 at row level. (We could also filter
 * server-side via dimensionFilter on isKeyEvent, but client-side is
 * simpler + lets us see non-key events in logs if needed.)
 */
export interface GA4ConversionRow {
  date:       string;   // YYYY-MM-DD
  source:     string;
  medium:     string;
  eventName:  string;
  eventCount: number;   // count of this event for the (date, source, medium) tuple
  keyEvents:  number;   // count of those that were key events
  eventValue: number;   // sum of monetary values reported via gtag('event', { value: 99.99, currency: 'USD' })
  currency:   string;   // empty string if event has no currency
}

export async function fetchDailyConversions(opts: {
  propertyId:  string;
  startDate:   string;
  endDate:     string;
  accessToken: string;
}): Promise<GA4ConversionRow[]> {
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
          { name: "eventName" },
          { name: "currency" },
        ],
        metrics: [
          { name: "eventCount" },
          { name: "keyEvents" },
          { name: "eventValue" },
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

  const rows: GA4ConversionRow[] = [];
  for (const row of json.rows ?? []) {
    const rawDate   = row.dimensionValues[0].value;  // "YYYYMMDD"
    // GA4 returns dates without hyphens — insert them for ISO 8601
    const date      = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
    const keyEvents = parseInt(row.metricValues[1]?.value ?? "0", 10);
    // Skip rows with no key events so we only store actual conversion rows
    if (keyEvents === 0) continue;
    rows.push({
      date,
      source:     row.dimensionValues[1].value,
      medium:     row.dimensionValues[2].value,
      eventName:  row.dimensionValues[3].value,
      currency:   row.dimensionValues[4].value,
      eventCount: parseInt(row.metricValues[0]?.value ?? "0", 10),
      keyEvents,
      eventValue: parseFloat(row.metricValues[2]?.value ?? "0"),
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

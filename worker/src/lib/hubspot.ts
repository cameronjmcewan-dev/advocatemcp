/**
 * HubSpot CRM API client. Pulls contacts + their associated deals so
 * we can compute LTV per contact. Used by /api/client/traffic-impact/ltv
 * for live passthrough — we never persist contact data in our D1.
 *
 * Refresh-token flow: tokens expire after 30min; refreshHubspotAccessToken()
 * returns a new access token from the stored refresh_token. Caller
 * (the read endpoint) calls this once per request.
 *
 * Phase 5 PR 1 of the data-depth roadmap. No persistence — passthrough
 * architecture per the privacy posture decision (May 6 2026 evening).
 */

// ── refreshHubspotAccessToken ─────────────────────────────────────────────────

/**
 * Exchange a HubSpot refresh token for a fresh access token.
 *
 * HubSpot access tokens are short-lived (~30 min). The caller should
 * call this once per inbound request and use the returned accessToken
 * for all subsequent API calls within that request lifetime.
 *
 * Errors are prefixed "hubspot:" for grep-friendly logs.
 */
export async function refreshHubspotAccessToken(
  refreshToken: string,
  clientId:     string,
  clientSecret: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const res = await fetch("https://api.hubapi.com/oauth/v1/token", {
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
    throw new Error(`hubspot: token refresh failed: ${res.status} ${snippet}`);
  }

  const json = (await res.json()) as {
    access_token?: string;
    expires_in?:   number;
  };

  if (!json.access_token) {
    throw new Error("hubspot: token refresh returned no access_token");
  }

  return {
    accessToken: json.access_token,
    expiresIn:   json.expires_in ?? 1800,
  };
}

// ── Contact shape ─────────────────────────────────────────────────────────────

export interface HubspotContact {
  id:              string;
  email:           string | null;
  createdAt:       string;         // ISO date
  lifecycleStage?: string;         // 'subscriber' | 'lead' | 'opportunity' | 'customer' | 'evangelist' | etc.
  totalRevenue?:   number;         // SUM of associated closed-won deals' amount
}

// ── fetchContactsWithRevenue ──────────────────────────────────────────────────

/**
 * Fetch HubSpot contacts created on or after `createdAfter`, paginating
 * up to `maxContacts`. For each contact, fetch associated closed-won
 * deals and sum their `amount` property into `totalRevenue`.
 *
 * Revenue per contact is computed via the associations API to avoid
 * fetching every deal in the account — we only fetch the deal IDs
 * associated with each contact, then pull each deal individually.
 *
 * Errors are prefixed "hubspot:" for grep-friendly logs.
 */
export async function fetchContactsWithRevenue(opts: {
  accessToken:   string;
  /** ISO date string — only contacts created on/after this are returned. */
  createdAfter:  string;
  /** Hard cap on total contacts to avoid runaway pagination. Default 1000. */
  maxContacts?:  number;
}): Promise<HubspotContact[]> {
  const { accessToken, createdAfter, maxContacts = 1000 } = opts;

  const contacts: HubspotContact[] = [];
  let after: string | undefined;

  // Paginate contacts via the search endpoint
  while (contacts.length < maxContacts) {
    const batchSize = Math.min(100, maxContacts - contacts.length);

    const searchBody: Record<string, unknown> = {
      filterGroups: [{
        filters: [{
          propertyName: "createdate",
          operator:     "GTE",
          value:        String(new Date(createdAfter).getTime()),
        }],
      }],
      properties: ["email", "createdate", "lifecyclestage"],
      limit:       batchSize,
    };
    if (after) {
      searchBody.after = after;
    }

    const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(searchBody),
    });

    if (!res.ok) {
      const snippet = (await res.text()).slice(0, 200);
      throw new Error(`hubspot: contacts search failed: ${res.status} ${snippet}`);
    }

    const json = (await res.json()) as {
      results?: Array<{
        id: string;
        properties: {
          email?:          string | null;
          createdate?:     string | null;
          lifecyclestage?: string | null;
        };
        createdAt?: string;
      }>;
      paging?: { next?: { after?: string } };
    };

    const results = json.results ?? [];
    if (results.length === 0) break;

    for (const r of results) {
      const rawCreatedAt =
        r.createdAt ??
        (r.properties.createdate
          ? new Date(Number(r.properties.createdate)).toISOString()
          : "");

      const contact: HubspotContact = {
        id:             r.id,
        email:          r.properties.email ?? null,
        createdAt:      rawCreatedAt,
        lifecycleStage: r.properties.lifecyclestage ?? undefined,
        totalRevenue:   0,
      };

      // Fetch associated closed-won deals and sum revenue
      contact.totalRevenue = await fetchContactRevenue(r.id, accessToken);

      contacts.push(contact);
      if (contacts.length >= maxContacts) break;
    }

    // Advance pagination cursor
    after = json.paging?.next?.after;
    if (!after) break;
  }

  return contacts;
}

// ── fetchContactRevenue ───────────────────────────────────────────────────────

/**
 * For a single contact, fetch associated deal IDs, then for each deal
 * check if it is closed-won and return the sum of `amount` properties.
 *
 * This is intentionally O(contacts × deals_per_contact) for v1 simplicity.
 * A batch-associations approach would reduce API calls for high-volume
 * accounts — that optimisation deferred to a future PR.
 */
async function fetchContactRevenue(
  contactId:   string,
  accessToken: string,
): Promise<number> {
  // Step 1: get deal IDs associated with this contact
  const assocRes = await fetch(
    `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(contactId)}/associations/deals`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!assocRes.ok) {
    // Non-fatal — return 0 revenue if we can't fetch associations
    return 0;
  }

  const assocJson = (await assocRes.json()) as {
    results?: Array<{ id: string }>;
  };
  const dealIds = (assocJson.results ?? []).map((r) => r.id);
  if (dealIds.length === 0) return 0;

  let totalRevenue = 0;

  for (const dealId of dealIds) {
    const dealRes = await fetch(
      `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=dealstage,amount`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!dealRes.ok) continue;

    const dealJson = (await dealRes.json()) as {
      properties?: {
        dealstage?: string | null;
        amount?:    string | null;
      };
    };

    // Only count closed-won deals
    if (dealJson.properties?.dealstage === "closedwon") {
      const amount = parseFloat(dealJson.properties?.amount ?? "0");
      if (!isNaN(amount)) {
        totalRevenue += amount;
      }
    }
  }

  return totalRevenue;
}

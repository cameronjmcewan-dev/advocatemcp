import { classifyTrafficSource } from "./aiTrafficClassifier";
import type { GA4GeoRow } from "./ga4";

interface GeoBucket {
  ai_sessions:    number;
  human_sessions: number;
}

/**
 * Aggregate raw GA4 geo rows into (date, country, city) buckets with
 * AI vs Human classification. Returns a Map keyed by "date|country|city"
 * → GeoBucket + coordinate fields. The caller writes each bucket as one upsert.
 */
export function aggregateGeoRows(rows: GA4GeoRow[]): Map<string, GeoBucket & {
  date: string; country: string; city: string;
}> {
  const out = new Map<string, GeoBucket & { date: string; country: string; city: string }>();
  for (const r of rows) {
    const key = `${r.date}|${r.country}|${r.city}`;
    let bucket = out.get(key);
    if (!bucket) {
      bucket = { date: r.date, country: r.country, city: r.city, ai_sessions: 0, human_sessions: 0 };
      out.set(key, bucket);
    }
    const cls = classifyTrafficSource(r.source, r.medium);
    if (cls === "ai") bucket.ai_sessions    += r.sessions;
    else              bucket.human_sessions += r.sessions;
  }
  return out;
}

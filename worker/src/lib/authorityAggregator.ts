/**
 * Aggregates per-mention sentiment results into a daily roll-up
 * suitable for off_site_authority_daily. Pure function.
 *
 * Per-day positive_count / neutral_count / negative_count are simple
 * tallies. avg_sentiment is the mean of all scores (range -1..1).
 * top_mentions_json captures the top-3 by absolute score (most
 * extreme mentions, regardless of direction) for tooltip context —
 * truncated to 200 chars per mention to bound storage size.
 */

export interface DailyAuthorityBucket {
  date:              string;
  platform:          string;
  mention_count:     number;
  positive_count:    number;
  neutral_count:     number;
  negative_count:    number;
  avg_sentiment:     number | null;
  rating?:           number | null;
  rating_count?:     number | null;
  top_mentions_json: string;
}

interface AuthorityMentionInput {
  id:           string;
  text:         string;
  permalink?:   string;
  created_utc:  number; // unix seconds
  sentiment:    { label: string; score: number; theme?: string };
}

interface TopMentionEntry {
  text:        string;
  score:       number;
  theme?:      string;
  permalink?:  string;
  created_utc: number;
}

const MAX_MENTION_TEXT_CHARS = 200;
const TOP_MENTIONS_COUNT     = 3;

export function aggregateAuthorityMentions(
  platform: string,
  mentions: AuthorityMentionInput[],
): Map<string, DailyAuthorityBucket> {
  const buckets = new Map<string, DailyAuthorityBucket>();
  // Track the raw mention entries per date for top-3 computation
  const rawByDate = new Map<string, AuthorityMentionInput[]>();

  for (const m of mentions) {
    const date = utcDateFromUnix(m.created_utc);

    // Accumulate into bucket
    let bucket = buckets.get(date);
    if (!bucket) {
      bucket = {
        date,
        platform,
        mention_count:     0,
        positive_count:    0,
        neutral_count:     0,
        negative_count:    0,
        avg_sentiment:     null,
        top_mentions_json: "[]",
      };
      buckets.set(date, bucket);
    }

    bucket.mention_count += 1;
    const label = m.sentiment.label;
    if (label === "positive") bucket.positive_count += 1;
    else if (label === "negative") bucket.negative_count += 1;
    else bucket.neutral_count += 1;

    // Accumulate scores for avg (we'll compute after the loop)
    const raw = rawByDate.get(date) ?? [];
    raw.push(m);
    rawByDate.set(date, raw);
  }

  // Finalise each bucket: avg_sentiment + top_mentions_json
  for (const [date, bucket] of buckets.entries()) {
    const raw = rawByDate.get(date) ?? [];

    // avg_sentiment = mean of scores
    if (raw.length > 0) {
      const sum = raw.reduce((acc, m) => acc + m.sentiment.score, 0);
      bucket.avg_sentiment = sum / raw.length;
    }

    // top_mentions_json: top-3 by abs(score) desc
    const top: TopMentionEntry[] = raw
      .slice()
      .sort((a, b) => Math.abs(b.sentiment.score) - Math.abs(a.sentiment.score))
      .slice(0, TOP_MENTIONS_COUNT)
      .map((m) => {
        const entry: TopMentionEntry = {
          text:        m.text.slice(0, MAX_MENTION_TEXT_CHARS),
          score:       m.sentiment.score,
          created_utc: m.created_utc,
        };
        if (m.sentiment.theme) entry.theme = m.sentiment.theme;
        if (m.permalink)       entry.permalink = m.permalink;
        return entry;
      });

    bucket.top_mentions_json = JSON.stringify(top);
  }

  return buckets;
}

/** Convert a Unix timestamp (seconds) to a YYYY-MM-DD date string in UTC. */
function utcDateFromUnix(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

/**
 * Reddit public-API client. Reads recent submissions + comments
 * mentioning a customer's brand keyword. Uses the public JSON API
 * (no OAuth required for read).
 *
 * Rate limits: Reddit's public API throttles aggressively. We cap at
 * one query per tenant per day in the cron. Each query returns up to
 * 25 most-recent results — enough to feed sentiment classification
 * within the daily 100-mention budget without burning quota.
 *
 * User-Agent: required by Reddit ToS. We send a descriptive identifier
 * with our domain (Reddit's docs: "Setting a custom User-Agent header
 * helps prevent being aggressively rate-limited"). The header value
 * 'web:advocatemcp-authority-kit:v1' identifies our deployment.
 */

export interface RedditMention {
  id:          string;       // t3_xxx (submission) or t1_xxx (comment)
  subreddit:   string;
  permalink:   string;       // https://reddit.com/r/.../comments/...
  author:      string;       // can be "[deleted]"
  text:        string;       // submission title + selftext, OR comment body
  created_utc: number;       // unix seconds
  score:       number;       // upvotes
}

export class RedditRateLimitError extends Error {
  readonly retryAfter: number | null;

  constructor(retryAfter: number | null = null) {
    super("reddit: rate limited by Reddit API");
    this.name = "RedditRateLimitError";
    this.retryAfter = retryAfter;
  }
}

const REDDIT_USER_AGENT = "web:advocatemcp-authority-kit:v1";

export async function searchRedditMentions(opts: {
  brandKeyword: string;
  limit?: number; // default 25 (Reddit's max per request without OAuth)
}): Promise<RedditMention[]> {
  const limit = opts.limit ?? 25;
  const url =
    `https://www.reddit.com/search.json?q=${encodeURIComponent(opts.brandKeyword)}&sort=new&limit=${limit}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { "User-Agent": REDDIT_USER_AGENT },
    });
  } catch (err) {
    throw new Error(`reddit: search failed: network error: ${String(err)}`);
  }

  if (resp.status === 429) {
    const retryAfterHeader = resp.headers.get("Retry-After");
    const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : null;
    throw new RedditRateLimitError(isNaN(retryAfter as number) ? null : retryAfter);
  }

  if (!resp.ok) {
    throw new Error(`reddit: search failed: ${resp.status}`);
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    throw new Error("reddit: search failed: invalid JSON response");
  }

  const children = (body as any)?.data?.children;
  if (!Array.isArray(children)) {
    return [];
  }

  const mentions: RedditMention[] = [];

  for (const child of children) {
    const kind = child?.kind as string | undefined;
    const data = child?.data;
    if (!data) continue;

    const author = data.author as string | undefined;
    if (!author || author === "[deleted]") continue;

    let text: string;
    if (kind === "t3") {
      // Submission: combine title + selftext
      const title    = (data.title    as string | undefined) ?? "";
      const selftext = (data.selftext as string | undefined) ?? "";
      text = selftext ? `${title}\n\n${selftext}` : title;
    } else if (kind === "t1") {
      // Comment
      text = (data.body as string | undefined) ?? "";
    } else {
      continue;
    }

    if (!text.trim()) continue;

    const permalink = (data.permalink as string | undefined) ?? "";

    mentions.push({
      id:          `${kind}_${data.id as string}`,
      subreddit:   (data.subreddit as string | undefined) ?? "",
      permalink:   permalink.startsWith("http") ? permalink : `https://reddit.com${permalink}`,
      author,
      text,
      created_utc: (data.created_utc as number | undefined) ?? 0,
      score:       (data.score       as number | undefined) ?? 0,
    });
  }

  return mentions;
}

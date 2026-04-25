/* Shared rendering helpers used across multiple variants — extracted
 * so the per-bot formats stay short and the schema/escape logic is in
 * one place. */

import type { BusinessRow } from "../../../db.js";

export function escapeHtml(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Best-effort split of "City, ST" / "City, State" into address parts. */
export function splitLocation(loc: string | null | undefined): {
  city?: string;
  state?: string;
} {
  if (!loc) return {};
  const parts = loc.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { city: parts[0] };
  return { city: parts[0], state: parts[1] };
}

/** Build LocalBusiness / ProfessionalService JSON-LD from a profile.
 *  Caller chooses which @type to emit and which subset of fields to
 *  include (Perplexity wants ratings; Google wants the full battery). */
export function buildBusinessJsonLd(
  business: BusinessRow,
  opts: {
    type?: "LocalBusiness" | "ProfessionalService" | "Organization";
    includeRating?: boolean;
    includeAddress?: boolean;
    includeKnowsAbout?: boolean;
    includeServiceArray?: boolean;
    canonicalUrl?: string;
  } = {},
): Record<string, unknown> {
  const type = opts.type ?? "LocalBusiness";
  const loc = splitLocation(business.location ?? null);

  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": type,
    name: business.name,
    description: business.description ?? "",
  };

  const url = opts.canonicalUrl ?? business.website ?? undefined;
  if (url) {
    ld["@id"] = url;
    ld.url = url;
  }
  if (business.phone) ld.telephone = business.phone;

  if (opts.includeAddress !== false && loc.city) {
    ld.address = {
      "@type": "PostalAddress",
      addressLocality: loc.city,
      ...(loc.state ? { addressRegion: loc.state } : {}),
      addressCountry: "US",
    };
  }

  if (
    opts.includeRating !== false &&
    business.star_rating != null
  ) {
    ld.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: business.star_rating,
      reviewCount: business.review_count ?? 1,
      bestRating: 5,
      worstRating: 0,
    };
  }

  if (opts.includeKnowsAbout && business.top_services) {
    ld.knowsAbout = business.top_services
      .split(/[,;]\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (opts.includeServiceArray && business.top_services) {
    ld.makesOffer = business.top_services
      .split(/[,;]\s*/)
      .map((s) => ({
        "@type": "Offer",
        itemOffered: { "@type": "Service", name: s.trim() },
      }))
      .filter((o) => o.itemOffered.name);
  }

  return ld;
}

export function buildFaqJsonLd(
  query: string,
  answerText: string,
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: query,
        acceptedAnswer: {
          "@type": "Answer",
          text: answerText,
        },
      },
    ],
  };
}

export function jsonLdScript(obj: Record<string, unknown>): string {
  return `<script type="application/ld+json">\n${JSON.stringify(obj, null, 2)}\n</script>`;
}

/** Convert markdown bold (`**foo**`) to HTML strong tags. Not a
 *  full markdown parser — just enough so per-bot HTML variants can
 *  re-use the bold formatting Claude produces. */
export function mdBoldToHtml(s: string): string {
  return s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

/** Convert markdown bullet list (lines starting with "- ") to a `<ul>`. */
export function mdBulletsToHtml(s: string): string {
  const lines = s.split("\n");
  const out: string[] = [];
  let inList = false;
  for (const line of lines) {
    const m = line.match(/^[-*]\s+(.*)$/);
    if (m) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`  <li>${mdBoldToHtml(m[1])}</li>`);
    } else {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      if (line.trim()) {
        out.push(`<p>${mdBoldToHtml(line)}</p>`);
      }
    }
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

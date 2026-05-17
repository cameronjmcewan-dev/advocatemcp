/**
 * Tests for the four cross-renderer schema/meta helpers added to
 * shared.ts as part of the grey-area expansion pass:
 *
 *   - buildSpeakableJsonLd       — voice-first AI extractor hooks
 *   - buildBreadcrumbJsonLd      — navigation context for citation chains
 *   - articleFreshnessMetaTags   — recency signal (datePublished + dateModified)
 *   - citationMetaTags           — Google Scholar / academic citation_* metas
 *
 * Each helper was previously either inlined in one renderer (and missing
 * from the others) or absent entirely. Lifting them into shared.ts and
 * locking the shape with unit tests means every per-bot renderer
 * (Claude / OpenAI / Google / Perplexity) emits the same signal — no
 * per-tenant config, no inconsistency across the four bot families.
 */

import { describe, it, expect } from "vitest";
import {
  buildSpeakableJsonLd,
  buildBreadcrumbJsonLd,
  articleFreshnessMetaTags,
  citationMetaTags,
} from "./shared.js";

describe("buildSpeakableJsonLd", () => {
  it("emits a WebPage with SpeakableSpecification pointing at h1 + first paragraph", () => {
    const ld = buildSpeakableJsonLd(
      { name: "Acme Widgets" },
      "https://acme.example",
    );
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("WebPage");
    expect(ld.name).toBe("Acme Widgets");
    expect(ld.url).toBe("https://acme.example");
    expect((ld.speakable as Record<string, unknown>)["@type"]).toBe("SpeakableSpecification");
    expect((ld.speakable as Record<string, unknown>).cssSelector).toEqual([
      "article > h1",
      "article > p:first-of-type",
    ]);
  });

  it("uses the same selectors regardless of business name (consistent voice signal across tenants)", () => {
    const a = buildSpeakableJsonLd({ name: "A" }, "https://a.example");
    const b = buildSpeakableJsonLd({ name: "B" }, "https://b.example");
    expect((a.speakable as Record<string, unknown>).cssSelector)
      .toEqual((b.speakable as Record<string, unknown>).cssSelector);
  });
});

describe("buildBreadcrumbJsonLd", () => {
  it("emits a two-step list when the business has a category", () => {
    const ld = buildBreadcrumbJsonLd(
      { name: "Acme Plumbing", category: "Plumbing" },
      "https://acme.example",
    );
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("BreadcrumbList");
    const items = ld.itemListElement as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      "@type":   "ListItem",
      "position": 1,
      "name":    "Plumbing",
      "item":    "https://acme.example",
    });
    expect(items[1]).toEqual({
      "@type":   "ListItem",
      "position": 2,
      "name":    "Acme Plumbing",
      "item":    "https://acme.example",
    });
  });

  it("emits a single-step list when category is missing (no 'Business' filler)", () => {
    const ld = buildBreadcrumbJsonLd(
      { name: "Acme", category: null },
      "https://acme.example",
    );
    const items = ld.itemListElement as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      "@type":    "ListItem",
      "position": 1,
      "name":     "Acme",
      "item":     "https://acme.example",
    });
  });

  it("treats empty/whitespace category as no category", () => {
    // Regression catcher: an empty-string category would otherwise emit
    // a naked breadcrumb step with an empty `name`, which Google's
    // Rich Results checker flags as an error.
    const a = buildBreadcrumbJsonLd({ name: "Acme", category: "" }, "https://acme.example");
    const b = buildBreadcrumbJsonLd({ name: "Acme", category: "   " }, "https://acme.example");
    expect((a.itemListElement as unknown[]).length).toBe(1);
    expect((b.itemListElement as unknown[]).length).toBe(1);
  });
});

describe("articleFreshnessMetaTags", () => {
  it("emits both article:published_time and article:modified_time", () => {
    const html = articleFreshnessMetaTags("2026-05-17T15:00:00Z");
    expect(html).toContain('<meta property="article:published_time" content="2026-05-17T15:00:00Z">');
    expect(html).toContain('<meta property="article:modified_time" content="2026-05-17T15:00:00Z">');
  });

  it("treats modifiedIso as the published date when no publishedIso is supplied", () => {
    // Pragmatic default: a freshly-rendered response IS the publication
    // moment for that variant. Forcing callers to pass two timestamps
    // every time would be friction with no benefit at render time.
    const html = articleFreshnessMetaTags("2026-05-17T15:00:00Z");
    const pubLine = html.match(/article:published_time.*?content="([^"]+)"/)?.[1];
    const modLine = html.match(/article:modified_time.*?content="([^"]+)"/)?.[1];
    expect(pubLine).toBe(modLine);
  });

  it("uses the supplied publishedIso when caller distinguishes the two", () => {
    const html = articleFreshnessMetaTags(
      "2026-05-17T15:00:00Z", // modified
      "2026-01-01T00:00:00Z", // published
    );
    expect(html).toContain('content="2026-01-01T00:00:00Z"');
    expect(html).toContain('content="2026-05-17T15:00:00Z"');
  });
});

describe("citationMetaTags", () => {
  it("emits all seven citation_* meta tags", () => {
    const html = citationMetaTags(
      { name: "Acme Plumbing" },
      "https://acme.example",
      "2026-05-17T15:00:00Z",
    );
    expect(html).toContain('<meta name="citation_title" content="Acme Plumbing">');
    expect(html).toContain('<meta name="citation_author" content="Acme Plumbing">');
    expect(html).toContain('<meta name="citation_publisher" content="AdvocateMCP">');
    expect(html).toContain('<meta name="citation_publication_date" content="2026-05-17">');
    expect(html).toContain('<meta name="citation_online_date" content="2026-05-17">');
    expect(html).toContain('<meta name="citation_fulltext_world_readable" content="">');
    expect(html).toContain('<meta name="citation_public_url" content="https://acme.example">');
  });

  it("derives YYYY-MM-DD from the ISO string for publication_date / online_date", () => {
    const html = citationMetaTags(
      { name: "Acme" },
      "https://acme.example",
      "2026-12-31T23:59:59.999Z",
    );
    expect(html).toContain('citation_publication_date" content="2026-12-31"');
    expect(html).toContain('citation_online_date" content="2026-12-31"');
  });

  it("HTML-escapes the business name (defense against quote injection in attrs)", () => {
    // Tenants can't currently set names containing `<` or `"`, but the
    // helper runs on user-controlled data. Escaping is cheap and
    // forecloses an attribute-injection vector if a future onboarding
    // path loosens validation.
    const html = citationMetaTags(
      { name: 'Evil"><script>alert(1)</script>' },
      "https://acme.example",
      "2026-05-17T15:00:00Z",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;");
    expect(html).toContain("&lt;script&gt;");
  });

  it("HTML-escapes the referral URL (defense against attribute injection)", () => {
    const html = citationMetaTags(
      { name: "Acme" },
      'https://acme.example"><script>alert(1)</script>',
      "2026-05-17T15:00:00Z",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;");
  });
});

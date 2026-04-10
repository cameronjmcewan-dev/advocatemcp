#!/usr/bin/env node
// Design-drift guard.
//
// Scans src/routes/*.ts for hardcoded hex colors and fails the build if any
// are found outside the shared layout module. This enforces the single source
// of truth documented in src/routes/sharedLayout.ts and CLAUDE.md.
//
// Allow-list escape hatch: add `// ok: <reason>` on the same line to exempt
// a specific hex value (e.g., white text on solid-green buttons, meta
// theme-color tags, JSON syntax-highlight colors).
//
// Usage:
//   npm run check:design
//   node scripts/check-design.mjs

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROUTES_DIR = resolve(new URL(".", import.meta.url).pathname, "..", "src", "routes");

// Files that are ALLOWED to contain raw hex (the palette source of truth).
const ALLOWLIST_FILES = new Set([
  "sharedLayout.ts",
  // portal.ts and dashboard.ts are explicitly out of scope for the first
  // migration pass — they still use their own legacy styles. Remove these
  // lines once they are migrated to sharedLayout tokens.
  "portal.ts",
  "dashboard.ts",
]);

// Substrings that indicate a line is a justified exception.
const LINE_EXEMPT_PATTERNS = [
  "// ok:",                         // explicit escape hatch
  'name="theme-color"',             // browser hint meta tags
  "color:#fff",                     // white text on solid buttons (both modes)
  "color: #fff",
  "background:#fff",                // rare — white card on colored bg
  "/* json-hex */",                 // JSON syntax-highlight marker
  'rel="manifest"',                 // PWA manifest inline JSON
];

// Hex color regex — must be preceded by a CSS-like boundary (start, space,
// colon, comma, paren, quote, semicolon) so we don't match `&#8592;` HTML
// entities or URL fragments like `/foo#bar`.
const HEX_RE = /(?:^|[\s:,(;'"=])(#[0-9a-fA-F]{3,8})\b/;

// JSON syntax-highlight CSS selectors — these classes intentionally use raw
// hex because they're semantic (code highlighting), not thematic. We detect
// them by the `.jk`, `.js`, `.jb`, `.jn` class pattern and skip the line.
const JSON_HIGHLIGHT_RE = /\.j[kjsnb]\{color:/;

function scanFile(relName) {
  const full = join(ROUTES_DIR, relName);
  const src = readFileSync(full, "utf8");
  const lines = src.split("\n");
  const hits = [];
  lines.forEach((line, i) => {
    if (!HEX_RE.test(line)) return;
    if (LINE_EXEMPT_PATTERNS.some((p) => line.includes(p))) return;
    if (JSON_HIGHLIGHT_RE.test(line)) return;
    hits.push({ line: i + 1, text: line.trim() });
  });
  return hits;
}

let totalHits = 0;
for (const name of readdirSync(ROUTES_DIR)) {
  if (!name.endsWith(".ts")) continue;
  if (ALLOWLIST_FILES.has(name)) continue;
  const hits = scanFile(name);
  if (hits.length === 0) continue;
  totalHits += hits.length;
  console.error(`\n✖ ${name} contains hardcoded hex colors:`);
  for (const h of hits) {
    console.error(`    line ${h.line}: ${h.text}`);
  }
}

if (totalHits > 0) {
  console.error(
    `\n✖ ${totalHits} hardcoded hex color(s) found in route files.\n` +
      `  Use CSS variables from src/routes/sharedLayout.ts instead.\n` +
      `  See CLAUDE.md for the full palette and exception rules.\n`,
  );
  process.exit(1);
}

console.log("✓ Design check passed — no stray hex colors in route files.");

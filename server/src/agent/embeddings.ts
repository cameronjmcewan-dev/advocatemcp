/**
 * Voyage embedding client + fire-and-forget persister.
 *
 * Uses Voyage's REST API via global fetch — bypasses the official
 * `voyageai` SDK because its ESM dist has an unresolved directory
 * import that crashes Node's strict ESM resolver at boot (Node 22
 * throws ERR_UNSUPPORTED_DIR_IMPORT against
 * voyageai/dist/esm/api). A ~25-line fetch wrapper gives us the
 * same surface without the broken package.
 *
 * Mirrors the classifyAndPersist pattern in src/agent/classify.ts: the
 * request handler inserts a queries row, then calls embedAndPersist(id,
 * text) without awaiting. Voyage latency is 100–200ms — keeping it off
 * the hot path is mandatory for the p95 guardrail.
 *
 * Storage: 512-dim Float32 packed into a SQLite BLOB (~2KB per row).
 * See src/lib/float32.ts for encoding.
 *
 * Kill switch: DISABLE_EMBEDDINGS=true short-circuits the whole thing.
 * Useful for tests that mock the hot path but don't care about
 * enrichment, and as an emergency lever if Voyage has an outage.
 */

import { getDb } from "../db.js";
import { vecToBlob } from "../lib/float32.js";

const EMBED_MODEL = process.env.VOYAGE_MODEL ?? "voyage-3.5-lite";
const EMBED_DIMS  = 512;
const VOYAGE_URL  = "https://api.voyageai.com/v1/embeddings";

interface VoyageEmbedResponse {
  object: string;
  data: Array<{ object: string; embedding: number[]; index: number }>;
  model: string;
  usage?: { total_tokens: number };
}

async function voyagePost(input: string[]): Promise<VoyageEmbedResponse> {
  const key = process.env.VOYAGE_API_KEY ?? "";
  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${key}`,
    },
    body: JSON.stringify({
      input,
      model: EMBED_MODEL,
      output_dimension: EMBED_DIMS,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`voyage: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as VoyageEmbedResponse;
}

/**
 * Embed a single string. Throws on API error — callers are expected to
 * catch (this is fire-and-forget downstream, but the raw fn stays honest
 * for batch callers in backfill).
 */
export async function embed(text: string): Promise<Float32Array> {
  const res = await voyagePost([text]);
  const raw = res?.data?.[0]?.embedding;
  if (!raw || !Array.isArray(raw) || raw.length !== EMBED_DIMS) {
    throw new Error(`voyage: unexpected embedding shape (len=${raw?.length ?? "missing"})`);
  }
  return new Float32Array(raw);
}

/**
 * Embed in a batch (for backfill). Voyage accepts up to 128 inputs per
 * call at the lite tier — we cap at 96 to leave headroom for retries.
 * Voyage may return rows in a different order than input; we reorder
 * by the `index` field so callers can assume positional correspondence.
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const res = await voyagePost(texts);
  const rows = res?.data;
  if (!Array.isArray(rows) || rows.length !== texts.length) {
    throw new Error(`voyage: batch shape mismatch (got ${rows?.length ?? "missing"}, expected ${texts.length})`);
  }
  const out: Float32Array[] = new Array(texts.length);
  for (const r of rows) {
    if (!r.embedding || r.embedding.length !== EMBED_DIMS) {
      throw new Error(`voyage: bad embedding at index ${r.index}`);
    }
    out[r.index] = new Float32Array(r.embedding);
  }
  return out;
}

/**
 * Fire-and-forget: embed + UPDATE queries.query_embedding. Mirrors
 * classifyAndPersist exactly — kill switch, COALESCE so manual
 * overwrites aren't clobbered, errors logged to stderr JSON.
 */
export function embedAndPersist(queryId: number, text: string): void {
  if (process.env.DISABLE_EMBEDDINGS === "true") return;

  void embed(text)
    .then((vec) => {
      try {
        const db = getDb();
        db.prepare(
          `UPDATE queries
              SET query_embedding = COALESCE(query_embedding, ?)
            WHERE id = ?`
        ).run(vecToBlob(vec), queryId);
      } catch (err) {
        console.error(JSON.stringify({
          event: "embed_persist_db_error",
          query_id: queryId,
          error: String(err),
        }));
      }
    })
    .catch((err) => {
      console.error(JSON.stringify({
        event: "embed_api_error",
        query_id: queryId,
        error: String(err?.message ?? err),
      }));
    });
}

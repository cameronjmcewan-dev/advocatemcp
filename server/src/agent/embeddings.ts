/**
 * Voyage embedding client + fire-and-forget persister.
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

import { VoyageAIClient } from "voyageai";
import { getDb } from "../db.js";
import { vecToBlob } from "../lib/float32.js";

const EMBED_MODEL = process.env.VOYAGE_MODEL ?? "voyage-3.5-lite";
const EMBED_DIMS  = 512;

let _client: VoyageAIClient | null = null;
function client(): VoyageAIClient {
  if (!_client) {
    _client = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY ?? "" });
  }
  return _client;
}

/**
 * Embed a single string. Throws on API error — callers are expected to
 * catch (this is fire-and-forget downstream, but the raw fn stays honest
 * for batch callers in backfill).
 */
export async function embed(text: string): Promise<Float32Array> {
  const res = await client().embed({
    input: [text],
    model: EMBED_MODEL,
    outputDimension: EMBED_DIMS,
  });
  const raw = res?.data?.[0]?.embedding;
  if (!raw || !Array.isArray(raw) || raw.length !== EMBED_DIMS) {
    throw new Error(`voyage: unexpected embedding shape (len=${raw?.length ?? "missing"})`);
  }
  return new Float32Array(raw);
}

/**
 * Embed in a batch (for backfill). Voyage accepts up to 128 inputs per
 * call at the lite tier — we cap at 96 to leave headroom for retries.
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const res = await client().embed({
    input: texts,
    model: EMBED_MODEL,
    outputDimension: EMBED_DIMS,
  });
  const rows = res?.data;
  if (!Array.isArray(rows) || rows.length !== texts.length) {
    throw new Error(`voyage: batch shape mismatch (got ${rows?.length ?? "missing"}, expected ${texts.length})`);
  }
  return rows.map((r, i) => {
    const raw = r?.embedding;
    if (!raw || raw.length !== EMBED_DIMS) {
      throw new Error(`voyage: bad embedding at index ${i}`);
    }
    return new Float32Array(raw);
  });
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

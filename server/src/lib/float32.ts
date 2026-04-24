/**
 * Float32Array <-> SQLite BLOB helpers for query embeddings.
 *
 * SQLite BLOBs come back as Node Buffer; encoding is just the raw
 * little-endian float32 bytes. We don't stamp dimension inline — the
 * column type implies 512 dims for voyage-3.5-lite and the consuming
 * code asserts length at read time.
 */

export function vecToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function blobToVec(b: Buffer): Float32Array {
  // Buffer is a Uint8Array — copy to ensure alignment, then reinterpret.
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

/**
 * Cosine similarity on two equal-length vectors. Returns a value in
 * [-1, 1]. When either input has zero magnitude, returns 0 (avoids
 * NaN from 0/0 and gives a neutral "dissimilar" answer).
 */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSim: length mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let am = 0;
  let bm = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    am += a[i] * a[i];
    bm += b[i] * b[i];
  }
  if (am === 0 || bm === 0) return 0;
  return dot / (Math.sqrt(am) * Math.sqrt(bm));
}

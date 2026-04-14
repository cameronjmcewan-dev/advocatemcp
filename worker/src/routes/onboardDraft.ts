// worker/src/routes/onboardDraft.ts
import type { Env } from "../types";
import { jsonOk, jsonErr } from "./onboard";

type OkResult<T> = { ok: true; value: T };
type ErrResult = { ok: false; errors: string[] };
export type Result<T> = OkResult<T> | ErrResult;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateDraftPayload(
  raw: unknown,
): Result<{ email: string; step: number; payload: Record<string, unknown> }> {
  const errs: string[] = [];
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, errors: ["body must be object"] };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.email !== "string" || !EMAIL_RE.test(r.email)) {
    errs.push("email: valid email required");
  }
  if (typeof r.step !== "number" || !Number.isInteger(r.step) || r.step < 1 || r.step > 9) {
    errs.push("step: integer 1–9");
  }
  if (typeof r.payload !== "object" || r.payload === null || Array.isArray(r.payload)) {
    errs.push("payload: object required");
  }
  if (errs.length > 0) return { ok: false, errors: errs };
  return {
    ok: true,
    value: {
      email: (r.email as string).toLowerCase().trim(),
      step: r.step as number,
      payload: r.payload as Record<string, unknown>,
    },
  };
}

/** POST /api/onboard/draft — upsert in-progress wizard state */
export async function handleSaveDraft(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonErr(400, "invalid_json", "Body must be JSON");
  }
  const v = validateDraftPayload(body);
  if (!v.ok) return jsonErr(400, "validation_error", v.errors.join("; "));

  const now = new Date().toISOString();
  const payloadJson = JSON.stringify(v.value.payload);

  // Cap at 256 KB to prevent KV/D1 abuse
  if (payloadJson.length > 262144) {
    return jsonErr(413, "payload_too_large", "Draft payload exceeds 256 KB");
  }

  await env.DB.prepare(
    `INSERT INTO onboarding_drafts (email, payload_json, step, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       payload_json = excluded.payload_json,
       step = excluded.step,
       updated_at = excluded.updated_at`,
  ).bind(v.value.email, payloadJson, v.value.step, now, now).run();

  return jsonOk({ ok: true, email: v.value.email, step: v.value.step, updated_at: now });
}

/** GET /api/onboard/draft/:email — retrieve in-progress wizard state */
export async function handleLoadDraft(
  request: Request,
  env: Env,
  rawEmail: string,
): Promise<Response> {
  const email = rawEmail.toLowerCase().trim();
  if (!EMAIL_RE.test(email)) return jsonErr(400, "invalid_email", "Invalid email");

  const row = await env.DB.prepare(
    `SELECT payload_json, step, updated_at FROM onboarding_drafts WHERE email = ?`,
  ).bind(email).first<{ payload_json: string; step: number; updated_at: string }>();

  if (!row) return jsonErr(404, "not_found", "No draft for this email");

  let payload: unknown;
  try { payload = JSON.parse(row.payload_json); } catch { payload = {}; }
  return jsonOk({ email, step: row.step, updated_at: row.updated_at, payload });
}

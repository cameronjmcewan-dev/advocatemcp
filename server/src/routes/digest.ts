import { Router } from "express";
import type { Request, Response } from "express";
import { getDb } from "../db.js";
import { verifyUnsubscribeToken } from "../lib/unsubscribeToken.js";

export const digestRouter = Router();

const UNSUB_PAGE = (body: string, title: string): string => `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8"/>
    <title>${title} — AdvocateMCP</title>
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
  </head>
  <body style="margin:0;padding:40px 16px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111827">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;padding:32px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.1);text-align:center">
      ${body}
    </div>
  </body>
</html>`;

/**
 * GET /digest/unsubscribe/:token
 *
 * Verifies the HMAC-signed token, flips `digest_unsubscribed=1` on the
 * tenant row, and renders a confirmation page. Idempotent — re-visiting
 * the link after unsubscribing shows "already unsubscribed".
 *
 * Never returns a JSON error to a browser — this endpoint is reached by
 * humans clicking an email link, so every branch renders an HTML page.
 */
digestRouter.get("/digest/unsubscribe/:token", (req: Request, res: Response) => {
  const token = req.params.token;
  let slug: string;
  try {
    const payload = verifyUnsubscribeToken(token);
    slug = payload.slug;
  } catch {
    res.status(400)
      .set("Content-Type", "text/html")
      .set("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'")
      .send(
      UNSUB_PAGE(
        `<h1 style="font-size:20px;margin:0 0 8px 0">Invalid unsubscribe link</h1>
         <p style="color:#6b7280;font-size:14px;margin:0">If you meant to unsubscribe, please use the link at the bottom of the most recent digest email.</p>`,
        "Invalid link",
      ),
    );
    return;
  }

  const db = getDb();
  const existing = db.prepare("SELECT name, digest_unsubscribed FROM businesses WHERE slug=?")
    .get(slug) as { name: string; digest_unsubscribed: number } | undefined;
  if (!existing) {
    res.status(404)
      .set("Content-Type", "text/html")
      .set("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'")
      .send(
        UNSUB_PAGE(
          `<h1 style="font-size:20px;margin:0 0 8px 0">Account not found</h1>
           <p style="color:#6b7280;font-size:14px;margin:0">This unsubscribe link points to an account that no longer exists.</p>`,
          "Not found",
        ),
      );
    return;
  }

  if (existing.digest_unsubscribed === 0) {
    db.prepare("UPDATE businesses SET digest_unsubscribed=1 WHERE slug=?").run(slug);
  }

  const already = existing.digest_unsubscribed === 1;
  res.status(200)
    .set("Content-Type", "text/html")
    .set("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'")
    .send(
      UNSUB_PAGE(
        `<h1 style="font-size:20px;margin:0 0 8px 0">${already ? "Already unsubscribed" : "Unsubscribed"}</h1>
         <p style="color:#6b7280;font-size:14px;margin:0 0 16px 0">You'll no longer receive weekly radar digest emails for <strong>${existing.name.replace(/[<>&]/g, "")}</strong>.</p>
         <p style="color:#9ca3af;font-size:12px;margin:0">Want to re-subscribe? Contact <a href="mailto:support@advocatemcp.com" style="color:#0f766e">support@advocatemcp.com</a>.</p>`,
        already ? "Already unsubscribed" : "Unsubscribed",
      ),
    );
});

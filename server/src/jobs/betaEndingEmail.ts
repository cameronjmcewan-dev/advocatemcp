/**
 * Beta trial-ending email cron.
 *
 * Sends two reminders to each beta tenant:
 *
 *   T-7 days:  "Your beta wraps in a week. Full billing kicks in [date].
 *               Reply if you'd like to keep going, pause, or cancel."
 *
 *   T-1 day:   "Beta ends tomorrow. You'll be billed $X starting [date].
 *               Reply now if you want to cancel before billing."
 *
 * Idempotent. Each tenant gets each reminder exactly once — tracked
 * via a `beta_emails_sent` JSON column on businesses (lazy-created on
 * first send) listing which reminders have already gone out. The cron
 * runs daily; on each run it looks for tenants whose ends_at falls in
 * the right window AND who don't yet have that reminder logged.
 *
 * Failure mode: any send error is logged + we don't mark sent, so the
 * next cron run retries. Deliberately no exponential backoff here —
 * trial reminders are time-sensitive (a missed T-1 reminder is worse
 * than a duplicated one), and the worst case is double-send which is
 * a much smaller customer-experience hit than no-send.
 */

import { getDb } from "../db.js";
import { sendEmail } from "../lib/resend.js";
import cron from "node-cron";

const DEFAULT_SCHEDULE = "0 14 * * *"; // 14:00 UTC daily (~9am EST / 6am PST)

interface BetaTenantRow {
  slug:            string;
  name:            string;
  email:           string | null;
  beta_started_at: string | null;
  beta_ends_at:    string | null;
  beta_cohort:     string | null;
  beta_emails_sent: string | null;
  plan:            string;
}

interface SentLog {
  /** ISO timestamps when we sent each reminder. Allows audit + double-send avoidance. */
  t7?:  string;
  t1?:  string;
}

function parseSentLog(raw: string | null): SentLog {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as SentLog;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function fmtPlanPrice(plan: string): string {
  // Hardcoded pricing for the email body. Mirror of Pricing.html copy
  // — keep in sync if pricing changes. Beta tenants almost always
  // sign up on Base; Pro is rare in cohort 1.
  if (plan === "pro") return "$349/mo";
  return "$149/mo";
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month:   "short",
    day:     "numeric",
    year:    "numeric",
    timeZone: "UTC",
  });
}

interface ReminderArgs {
  businessName: string;
  endsAt:       string;
  plan:         string;
  daysLeft:     number;
}

function renderT7Email(a: ReminderArgs): { subject: string; html: string; text: string } {
  const subject = `Your AdvocateMCP beta wraps in 7 days, ${a.businessName}`;
  const text = [
    `Hi from AdvocateMCP,`,
    ``,
    `A heads-up: your beta cohort wraps on ${fmtDate(a.endsAt)} (about a week out).`,
    `Full pricing of ${fmtPlanPrice(a.plan)} kicks in then. Stripe handles the billing on your card already on file.`,
    ``,
    `If you'd like to:`,
    `  · Keep going at full pricing → no action needed`,
    `  · Pause or cancel before the trial ends → reply to this email`,
    `  · Tell us what's working / what's not → reply to this email (we read every one)`,
    ``,
    `Thanks for being part of the launch cohort.`,
    ``,
    `— AdvocateMCP`,
    ``,
    `max@advocate-mcp.com`,
  ].join("\n");

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#fbf9f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1816;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fbf9f5;padding:32px 16px">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e4ddd0;border-radius:10px;padding:32px">
        <tr><td>
          <div style="font-size:11px;color:#5c1a3c;letter-spacing:.06em;text-transform:uppercase;font-weight:600;margin-bottom:10px">AdvocateMCP · Beta cohort</div>
          <h1 style="margin:0 0 12px 0;font-size:22px;color:#1a1816;font-weight:600">Your beta wraps in 7 days</h1>
          <p style="margin:0 0 14px 0;font-size:15px;line-height:1.55;color:#2d2a26">
            Hi ${escapeHtml(a.businessName)} — quick heads-up that your AdvocateMCP beta ends on
            <strong>${fmtDate(a.endsAt)}</strong>. Full pricing of <strong>${fmtPlanPrice(a.plan)}</strong> kicks in then,
            using the card already on file.
          </p>
          <p style="margin:0 0 14px 0;font-size:15px;line-height:1.55;color:#2d2a26">
            <strong>If you'd like to:</strong>
          </p>
          <ul style="margin:0 0 18px 0;padding-left:20px;font-size:15px;line-height:1.7;color:#2d2a26">
            <li>Keep going at full pricing → no action needed</li>
            <li>Pause or cancel → reply to this email</li>
            <li>Tell us what's clicking / confusing → reply to this email (we read every one)</li>
          </ul>
          <p style="margin:24px 0 0 0;font-size:13px;color:#6b655c;border-top:1px solid #e4ddd0;padding-top:16px">
            Thanks for being part of the launch cohort.<br>
            Reply directly: <a href="mailto:max@advocate-mcp.com" style="color:#5c1a3c">max@advocate-mcp.com</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, html, text };
}

function renderT1Email(a: ReminderArgs): { subject: string; html: string; text: string } {
  const subject = `Last day of beta, ${a.businessName} — billing starts tomorrow`;
  const text = [
    `Hi from AdvocateMCP,`,
    ``,
    `Your beta ends tomorrow (${fmtDate(a.endsAt)}). Full pricing of ${fmtPlanPrice(a.plan)} starts then.`,
    ``,
    `If you want to cancel before billing, reply to this email today and we'll handle it.`,
    `Otherwise, we'll see you on the other side. Thanks for testing.`,
    ``,
    `— AdvocateMCP`,
    ``,
    `max@advocate-mcp.com`,
  ].join("\n");

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#fbf9f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1816;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fbf9f5;padding:32px 16px">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e4ddd0;border-radius:10px;padding:32px">
        <tr><td>
          <div style="font-size:11px;color:#5c1a3c;letter-spacing:.06em;text-transform:uppercase;font-weight:600;margin-bottom:10px">AdvocateMCP · Beta cohort</div>
          <h1 style="margin:0 0 12px 0;font-size:22px;color:#1a1816;font-weight:600">Last day of your beta, ${escapeHtml(a.businessName)}</h1>
          <p style="margin:0 0 14px 0;font-size:15px;line-height:1.55;color:#2d2a26">
            Your beta ends tomorrow on <strong>${fmtDate(a.endsAt)}</strong>. Full pricing of <strong>${fmtPlanPrice(a.plan)}</strong> kicks in then.
          </p>
          <p style="margin:0 0 14px 0;font-size:15px;line-height:1.55;color:#2d2a26">
            <strong>To cancel before billing:</strong> reply to this email today. We'll handle it.
          </p>
          <p style="margin:0 0 18px 0;font-size:15px;line-height:1.55;color:#2d2a26">
            Otherwise, we'll see you on the other side. Thanks for testing.
          </p>
          <p style="margin:24px 0 0 0;font-size:13px;color:#6b655c;border-top:1px solid #e4ddd0;padding-top:16px">
            <a href="mailto:max@advocate-mcp.com" style="color:#5c1a3c">max@advocate-mcp.com</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * One pass: scan beta tenants whose ends_at falls into the T-7 or T-1
 * window, send the right reminder, mark sent. Designed to be safe to
 * call repeatedly within the same UTC day — second call is a no-op.
 */
export async function sendBetaEndingReminders(): Promise<{
  scanned:    number;
  t7_sent:    number;
  t1_sent:    number;
  errors:     number;
}> {
  if (!process.env.RESEND_API_KEY) {
    console.warn("[beta-ending] skipped — RESEND_API_KEY not set");
    return { scanned: 0, t7_sent: 0, t1_sent: 0, errors: 0 };
  }
  const db = getDb();

  // Lazy-create the column once. This is also created in the migration
  // if it's run cleanly, but we re-CREATE here so a fresh-DB test
  // environment that hasn't run migrations yet doesn't crash.
  try {
    db.prepare("ALTER TABLE businesses ADD COLUMN beta_emails_sent TEXT").run();
  } catch {
    /* column already exists — safe to ignore */
  }

  const now = Date.now();
  const t7Floor = now + 6.5 * 24 * 60 * 60 * 1000; // 6.5 days from now
  const t7Ceil  = now + 7.5 * 24 * 60 * 60 * 1000;
  const t1Floor = now + 0.5 * 24 * 60 * 60 * 1000;
  const t1Ceil  = now + 1.5 * 24 * 60 * 60 * 1000;

  let rows: BetaTenantRow[];
  try {
    rows = db
      .prepare(
        `SELECT slug, name, email, beta_started_at, beta_ends_at, beta_cohort,
                beta_emails_sent, plan
           FROM businesses
          WHERE beta_started_at IS NOT NULL
            AND beta_ends_at IS NOT NULL`,
      )
      .all() as BetaTenantRow[];
  } catch (err) {
    console.warn(`[beta-ending] no beta rows readable: ${String(err)}`);
    return { scanned: 0, t7_sent: 0, t1_sent: 0, errors: 0 };
  }

  let t7Sent = 0;
  let t1Sent = 0;
  let errors = 0;

  for (const row of rows) {
    if (!row.email || !row.beta_ends_at) continue;
    const endsMs = Date.parse(row.beta_ends_at);
    if (Number.isNaN(endsMs)) continue;

    const sent = parseSentLog(row.beta_emails_sent);
    const args: ReminderArgs = {
      businessName: row.name,
      endsAt:       row.beta_ends_at,
      plan:         row.plan,
      daysLeft:     Math.max(0, Math.ceil((endsMs - now) / 86_400_000)),
    };

    // T-7 window
    if (!sent.t7 && endsMs >= t7Floor && endsMs <= t7Ceil) {
      const email = renderT7Email(args);
      try {
        await sendEmail({
          from:    process.env.DIGEST_EMAIL_FROM ?? "AdvocateMCP <max@advocate-mcp.com>",
          to:      row.email,
          subject: email.subject,
          html:    email.html,
          text:    email.text,
        });
        sent.t7 = new Date().toISOString();
        db.prepare("UPDATE businesses SET beta_emails_sent = ? WHERE slug = ?")
          .run(JSON.stringify(sent), row.slug);
        t7Sent++;
        console.log(`[beta-ending] T-7 sent to ${row.slug}`);
      } catch (err) {
        errors++;
        console.warn(`[beta-ending] T-7 failed for ${row.slug}: ${String(err)}`);
      }
    }

    // T-1 window
    if (!sent.t1 && endsMs >= t1Floor && endsMs <= t1Ceil) {
      const email = renderT1Email(args);
      try {
        await sendEmail({
          from:    process.env.DIGEST_EMAIL_FROM ?? "AdvocateMCP <max@advocate-mcp.com>",
          to:      row.email,
          subject: email.subject,
          html:    email.html,
          text:    email.text,
        });
        sent.t1 = new Date().toISOString();
        db.prepare("UPDATE businesses SET beta_emails_sent = ? WHERE slug = ?")
          .run(JSON.stringify(sent), row.slug);
        t1Sent++;
        console.log(`[beta-ending] T-1 sent to ${row.slug}`);
      } catch (err) {
        errors++;
        console.warn(`[beta-ending] T-1 failed for ${row.slug}: ${String(err)}`);
      }
    }
  }

  return { scanned: rows.length, t7_sent: t7Sent, t1_sent: t1Sent, errors };
}

export function startBetaEndingSchedule(): void {
  const schedule = process.env.BETA_ENDING_SCHEDULE_CRON ?? DEFAULT_SCHEDULE;
  if (!process.env.RESEND_API_KEY) {
    console.warn("[beta-ending] cron NOT scheduled — RESEND_API_KEY missing");
    return;
  }
  if (!cron.validate(schedule)) {
    console.warn(`[beta-ending] cron NOT scheduled — invalid schedule "${schedule}"`);
    return;
  }
  cron.schedule(schedule, () => {
    sendBetaEndingReminders()
      .then((r) => console.log(`[beta-ending] run complete: ${JSON.stringify(r)}`))
      .catch((err) => console.error("[beta-ending] cron threw:", err));
  });
  console.log(`[beta-ending] scheduled: ${schedule}`);
}

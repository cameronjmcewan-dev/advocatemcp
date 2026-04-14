/**
 * Send a budget/ops alert via Resend if configured, else log to stderr.
 * Never throws — alerting failures must not crash the cron.
 */
export async function sendBudgetAlert(subject: string, body: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const to     = process.env.ALERT_EMAIL_TO;
  const from   = process.env.ALERT_EMAIL_FROM ?? "alerts@advocatemcp.com";

  if (!apiKey || !to) {
    console.error(`[alert] ${subject} — ${body} (Resend not configured: RESEND_API_KEY/ALERT_EMAIL_TO)`);
    return;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, text: body }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const resBody = await res.text().catch(() => "");
      console.error(`[alert] resend ${res.status}: ${resBody.slice(0, 120)}`);
    }
  } catch (err) {
    console.error(`[alert] resend threw:`, err);
  }
}

export interface NotifyResult {
  delivered: boolean;
  reason: string;
  ticket_id?: string;
}

export async function sendSms(opts: { to: string; body: string }): Promise<NotifyResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !tok || !from) return { delivered: false, reason: "not_configured" };

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const auth = Buffer.from(`${sid}:${tok}`).toString("base64");
  const params = new URLSearchParams({ To: opts.to, From: from, Body: opts.body });
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    if (!resp.ok) return { delivered: false, reason: `http_${resp.status}` };
    const body = (await resp.json()) as { sid?: string };
    if (!body.sid) return { delivered: false, reason: "missing_sid" };
    return { delivered: true, reason: "ok", ticket_id: body.sid };
  } catch {
    return { delivered: false, reason: "fetch_error" };
  }
}

export async function sendEmail(_opts: { to: string; subject: string; body: string }): Promise<NotifyResult> {
  return { delivered: false, reason: "not_implemented" };
}

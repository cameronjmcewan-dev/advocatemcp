# Security Training Records

**Owner:** Max.
**Cadence:** Annual minimum, plus event-driven (after a Sev0/Sev1 incident,
after onboarding a new team member, after a major architectural change).

> SOC 2 CC1.4 requires evidence that personnel have been trained on
> security policies relevant to their role. For a solo founder this looks
> small, but the requirement is real — an auditor expects a dated record.

## What counts as training

For this org, "training" means any of:

- **Self-directed reading + dated notes** of a recognised resource (OWASP
  Top 10, CIS critical controls, vendor security docs, an O'Reilly /
  Manning book on the relevant area).
- **Course completion certificate** from a recognised provider (Coursera,
  Pluralsight, SANS, A Cloud Guru, Google Cybersecurity Cert).
- **Conference / talk attendance** with notes (DEF CON, BSides, Cloudflare
  Connect, KubeCon-security track).
- **Internal incident review** of one of our own postmortems with a
  written reflection ("what would I do differently in role").

A 30-second YouTube skim does NOT count. The bar is "an external party
could verify you absorbed the material from your notes."

## Training log

| Date | Person | Topic | Source | Time invested | Notes filed at |
|------|--------|-------|--------|---------------|----------------|
| _no entries yet_ | | | | | |

## Required topics by role

### Engineer (any)
- OWASP Top 10 (current year edition) — every 12 months.
- Secret-management hygiene (rotation, vault use, never-commit-to-git) — at hire + annual refresh.
- Postmortem of every Sev0/Sev1 incident the team has had — within 30 days of the incident.

### Operator / admin
All of the above, plus:
- Cloudflare account security best practices (MFA, API token scoping, audit log review) — annual.
- Stripe security best practices (webhook secret handling, restricted-key creation) — annual.
- Backup runbook walkthrough (`docs/backup-runbook.md`) — annual.

### Solo founder (current state)
Both of the above lists. Plus:
- One read-through of `docs/security-controls.md`, `docs/incident-response.md`,
  `docs/secrets-runbook.md`, `docs/risk-register.md` — quarterly.

## How to record a training event

1. Pick a topic from the Required list (or self-select if it covers a real gap).
2. Spend the time.
3. Write notes (any format — bullet list, markdown gist, paper notebook
   photo). The point is "I could prove I did this."
4. Add a row to the table above with the date, the source link/title, and
   a path/URL to your notes.
5. If the training surfaced a gap or an action item, file it in the
   relevant runbook OR in `docs/risk-register.md` as a new risk.

## Review

The training log is reviewed at the same quarterly cadence as the risk
register. If the most recent training entry is older than 12 months, that
is itself an action item.

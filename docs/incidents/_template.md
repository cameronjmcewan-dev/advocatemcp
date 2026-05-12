# Incident: <short title>

**Date:** YYYY-MM-DD
**Severity:** Sev0 / Sev1 / Sev2
**Started:** YYYY-MM-DD HH:MM UTC
**Resolved:** YYYY-MM-DD HH:MM UTC
**Duration:** N hours / N minutes
**Customer impact:** <one sentence>
**Authors:** <who wrote this>

## Summary

One paragraph. What happened, what was the impact, what fixed it. Should be
readable by someone (auditor, customer, future you) who doesn't know the
codebase.

## Timeline (UTC)

| Time | Event |
|------|-------|
| HH:MM | Symptom first observed (alert / customer / internal) |
| HH:MM | Acknowledged + working doc opened |
| HH:MM | First hypothesis: ... |
| HH:MM | Confirmed/ruled out via ... |
| HH:MM | Mitigation applied: ... |
| HH:MM | Customer-visible recovery confirmed |
| HH:MM | Resolved |

## Root cause

What ACTUALLY caused this. Not "human error" or "the deploy broke" — the
specific code path / config / assumption that failed. Should be specific
enough that the lesson is reusable.

## What went well

- ...
- ...

## What went poorly

Honest list. The audit reads this section first.

- ...
- ...

## Action items

| # | Owner | Action | Status |
|---|-------|--------|--------|
| 1 | max | <specific change> | open |
| 2 | max | <specific change> | open |

Each action must be specific, owned, and verifiable. "Be more careful" is
not an action item. "Add boot-smoke test that imports the full bundle" is.

## Related

- Commit: `<sha>`
- Sentry issue: `<link>`
- PR: `<link>`

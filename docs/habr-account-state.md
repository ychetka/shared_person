# Habr account state

Audit of the browser profile used by the Habr driver, 2026-11-12
(read-only CDP/fetch probes; see docs/habr-driver-spec.md).

## Profile

- `audit-chrome` at `~/.chrome-audit-profile`, CDP on `:9223` - up.

## Sessions

- `habr.com`: **LOGGED_IN** as user `ychetka`. Evidence: settings/privacy
  page loads, user-menu present; `habrsession_id`, `connect_sid`,
  `habr_web_user_id` cookies persistent (~30d).
- `career.habr.com`: **LOGGED_IN** (`_career_session` +
  `remember_user_token`).

## Account tier

- `ychetka` is **sandbox-tier** (ReadOnly -> author pipeline per spec).
- Composer entry point: `https://habr.com/ru/sandbox/new/` (200, SPA
  shell) - reached via the "Write publication" link on
  `/ru/sandbox/start/`.
- `https://habr.com/ru/articles/new/` returns **404** for this account,
  even logged in. The recipe `hands-agent/recipes/habr_post.yaml` uses
  the sandbox URL; re-verify per-account before enabling (full accounts
  may keep `/ru/articles/new/`).

## Notes

- Login is a human step - no credentials in ENV (spec 2.3). Sessions
  persist via cookies; re-audit if the profile is rebuilt or cookies
  expire.
- Pangram and other site sessions in this profile are unaffected.

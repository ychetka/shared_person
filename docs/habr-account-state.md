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

## Composer DOM notes (verified 2026-11-12)

- The sandbox composer at `/ru/sandbox/new/` is a two-screen tiptap
  SPA. Screen 1 is title + body only; hubs, tags and the publish
  button live on screen 2, reached via the "Next to settings"
  (RU-labeled) button.
- Title and body are NOT input/contenteditable elements: they are
  plain divs inside `.ProseMirror` carrying a `data-placeholder`
  attribute (`div.title__wrapper` for the title, `div.node_paragraph`
  for the body, which also shows a slash-menu hint paragraph).
  `hands-agent/cdp.py` resolves them via the `[data-placeholder]`
  selector + attribute fallback in `cand()`.
- A WYSIWYG/markdown mode toggle exists top-right; which mode the
  body paste assumes is still pending live verification.

# X/Twitter developer app onboarding - hands-agent runbook

**NOT EXECUTED.** This document is the approval deliverable for
issue #63: it describes, step by step, what a hands-agent run at
developer.x.com WOULD do. The recipe is not built, nothing has been
run, no developer account or app exists yet, and no credentials have
been obtained. Approval of this document authorizes building and
running the recipe; it does not report a completed run.

Status: instruction document (2026-11-08), for developer sign-off
before any automation. Companion spec: `docs/x-twitter-driver-spec.md`
(the driver this app feeds); session model: `PLATFORM_ACCESS.md`
(audit Chrome profile, CDP :9223, `tools/chrome-audit.sh`).

## 1. Goal

Create one X developer app so the `platform: "x"` driver
(`docs/x-twitter-driver-spec.md` section 2.3) can run `X_DRIVER=api`.
The run must end with four credential values plus the handle:

- `X_API_KEY` - app consumer key.
- `X_API_SECRET` - app consumer secret.
- `X_ACCESS_TOKEN` - user access token for the account's own profile.
- `X_ACCESS_SECRET` - user access token secret.
- `X_HANDLE` - the account's handle without `@` (confirm, not create:
  the X account already exists and is logged in inside the audit
  profile).

OAuth 1.0a user context is the decided scheme (x-twitter-driver-spec
1.2): the dev portal mints owner tokens directly - no callback, no
3-legged consent round-trip, no expiry to refresh.

## 2. Portal runbook (what the hands-agent run would do)

All steps run in the audit Chrome profile (already logged in to
x.com as the account owner). Real OS input, per-step `shot` audit
trail, locate/verify loops - the standing hands-agent UX rules.
Anything resembling CAPTCHA, phone verification or a payment prompt
aborts the run to the operator; the recipe never solves them.

1. Open `https://developer.x.com` and sign in with the registered
   account (the audit-profile session should already satisfy this;
   a sign-in wall is an abort-and-escalate, not a recipe step).
2. Complete the developer portal signup if prompted. TIER CHECK
   (verify at run time): per x-twitter-driver-spec 1.1, API write
   access is paid in 2026 - the free tier ended Feb 2026 except
   classified Public Utility Apps, and self-serve moved to
   pay-per-use. The free tier may still allow app creation plus
   posting for the owner's own account at documented limits, but
   this must be confirmed against the CURRENT portal copy before
   proceeding - the run does not enter payment details; a
   paid-plan wall aborts to the developer for a budget decision.
3. Create a Project, then an App inside it, using the metadata in
   section 3 field-for-field.
4. App settings -> User authentication settings: set app permissions
   to "Read and write". OAuth 1.0a user-context WRITE is required
   for `POST /2/tweets` and media upload - "Read" alone mints
   tokens that cannot post and the failure only surfaces at the
   first live call.
5. Keys and tokens page: generate/copy the API Key and Secret, then
   generate the user Access Token and Secret for the owner account.
6. REGENERATION WARNING: permissions changed AFTER user tokens are
   generated do not retro-apply - if step 4 is touched after step 5,
   the Access Token + Secret must be regenerated or every write call
   fails with a permissions error. Order matters: permissions first,
   then token generation.
7. Copy all four values out. They leave the browser ONCE, into
   `../ENV` via the secrets flow (section 4) - never into queue
   payloads, logs, registry, TG output or the repo.
8. Confirm `X_HANDLE` from the profile page (the logged-in
   account's handle, verbatim, without `@`).

## 3. App metadata - field-by-field draft texts

Minimal-disclosure rule: every field is truthful and descriptive;
nothing advertises automation scale, scheduled posting volume or
multi-account use. X reviews app metadata - understatement that is
accurate beats marketing that invites scrutiny.

| Portal field | Draft value |
|---|---|
| App name | `shared-person-content-tools` |
| Description | `Personal developer tool used by the account owner to publish posts to their own X profile.` |
| Website URL | `https://github.com/ychetka/ai_trading` (the URL already registered on the LinkedIn app per session record - verify against `PLATFORM_ACCESS.md`; one consistent project identity) |
| Use case / justification | `I am building a personal tool that publishes content I have written to my own X account. I review every post before it is sent. The app calls POST /2/tweets with my own credentials; it does not read other users' data, does not post on behalf of anyone else, and does not run ads.` |
| Callback / redirect URLs | none needed - OAuth 1.0a user context mints owner tokens in-portal; leave empty unless the form forces a value (then reuse the website URL) |
| Project name | `shared-person` (or the portal default) |

Notes for the approver:

- The use-case text says "content I have written" - accurate: every
  published draft passes the human moderation card first; the tool
  never posts unreviewed generated text.
- Do NOT write "bot", "automation platform", "scheduled posting" or
  volume claims anywhere in the metadata - none is needed and all
  invite policy questions a single-owner tool does not have to
  answer.
- If the portal's signup form asks account-level questions
  (intended use, "will you sell data", etc.), answer in the first
  person: personal use, own account, no data resale, no government
  use.

## 4. Where the keys land

- `../ENV` (repo-external env file, never committed - the same file
  that already holds `LINKEDIN_*`/`VK_*`) gains:
  `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`,
  `X_HANDLE`; plus `X_DRIVER=api` when the driver ships.
- `docker-compose.yml` n8n env gains passthrough entries
  (`X_API_KEY=${X_API_KEY:-}` style - optional like the `LINKEDIN_*`
  vars, NOT `${VAR:?}` guards: X must not become a boot blocker).
- Secrets handling rule: values move into `../ENV` only - the
  repo-external env file (never committed), edited/appended
  directly like the `VK_*`/`LINKEDIN_*` keys already there; no
  separate upload tooling exists. They are never committed, never
  pasted into tickets/docs, and join the scrub sets
  (`scrub()`/`KNOWN_TOKENS` in sp-publish, `SECRET_VALUES` in
  sp-tg-moderation) when the driver lands (x-twitter-driver-spec
  2.3). Sim mode must run with all four unset.
- After `../ENV` is updated: `docker compose --env-file ../ENV up -d`
  to re-inject, then the spec's smoke path - `dry_run` queue file,
  then `test: true` once `PUBLISH_SIMULATE=0` (x-twitter-driver-spec
  3.1 checklist, items 4-6).

## 5. Approval checklist (sign off before any hands-agent run)

- [ ] Runbook steps (section 2) approved as written - including the
      abort points (CAPTCHA, phone verification, payment wall).
- [ ] Tier/budget confirmed: developer accepts whatever plan the
      portal requires for write access at run time, or the run aborts
      at step 2 and returns here.
- [ ] App metadata drafts (section 3) approved field-for-field, or
      edits recorded against the table.
- [ ] Secrets destination (section 4) approved: `../ENV` only, scrub
      sets when the driver ships, passthrough compose entries.
- [ ] Acknowledged: changing app permissions after token generation
      forces regenerating the user tokens (step 6).
- [ ] Acknowledged: this document authorizes building the recipe and
      one supervised run; the run itself still follows hands-agent
      UX rules (operator reachable, shot audit trail, abort on
      anything outside the written steps).

## 6. Sources

- Credential contract, auth scheme decision, env names, scrub sets:
  `docs/x-twitter-driver-spec.md` sections 1.2, 2.3, 3.1.
- Portal flow (project -> app -> permissions -> keys and tokens) and
  the regenerate-after-permission-change rule: developer.x.com portal
  layout as documented in x-twitter-driver-spec 3.1 - re-verify
  against the live portal at run time.
- Paid/free write-access status and rate limits:
  `docs/x-twitter-driver-spec.md` 1.1 - flagged verify-at-run-time.
- Session model and secrets conventions: `PLATFORM_ACCESS.md`,
  `tools/chrome-audit.sh`, `README.md` (../ENV, compose env).

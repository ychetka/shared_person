# X/Twitter developer app onboarding - hands-agent runbook

**NOT EXECUTED.** This document is the approval deliverable for
issue #63: it describes, step by step, what a hands-agent run at
developer.x.com WOULD do. The recipe is not built, nothing has been
run past the exploration pass, no developer app exists yet, and no
credentials have been obtained. Approval of this document authorizes
building and running the recipe; it does not report a completed run.

Live exploration findings (2026-11-08, audit browser, CDP :9223):

- Account `@varenicX` is logged in on `x.com/home` inside the audit
  profile - `X_HANDLE` is confirmed as `varenicX`.
- `developer.x.com` redirects to `console.x.com/onboarding`: the
  developer-portal onboarding was NEVER completed. No apps, no API
  keys, nothing exists to extract - the run must start with
  onboarding itself, not with app creation.
- The onboarding form is: account name input + use-case textarea
  (required, asks for a "data protection" rationale) + Developer
  Agreement checkbox + optional marketing checkbox + Submit.
- Per developer: the X API write tier is PAID since Feb 2026 - the
  free/onboarding path is expected to hit a paid-plan wall (see
  step 2c, budget gate).

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
- `X_HANDLE` - the account's handle without `@`: CONFIRMED as
  `varenicX` (live exploration 2026-11-08 - the account is logged
  in on `x.com/home` inside the audit profile; the run verifies the
  handle on the profile page but does not create an account).

OAuth 1.0a user context is the decided scheme (x-twitter-driver-spec
1.2): the dev portal mints owner tokens directly - no callback, no
3-legged consent round-trip, no expiry to refresh.

## 2. Portal runbook (what the hands-agent run would do)

All steps run in the audit Chrome profile (already logged in to
x.com as `@varenicX`). Real OS input, per-step `shot` audit
trail, locate/verify loops - the standing hands-agent UX rules.

**Escalation contract (no silent stops).** Whenever the recipe hits a
wall it cannot cross, it does not just stop - it writes the task
result file with `status: "operator_required"` (or `status:
"aborted"` for a hard abort), names the wall and the tab/origin it
sits on, and raises the developer through the orchestrator bridge
(bridge ask/notice to the operator chat) so a human can act in the
live audit browser. The recipe waits for the operator's bridge reply
before resuming or parking:

- CAPTCHA: abort-and-escalate. The recipe never solves a CAPTCHA;
  it parks in `operator_required`, escalates via the bridge, and the
  developer solves it interactively (or orders the abort).
- Phone verification: NOT an abort - the developer is ready to pass
  it himself; see step 2b.
- Payment prompt / paid-plan wall: abort-and-escalate as a BUDGET
  decision; see step 2c.
- Sign-in wall or anything else outside the written steps: same
  abort-and-escalate path.

1. Open `https://developer.x.com`. Confirmed at exploration time:
   this redirects to `console.x.com/onboarding` (the audit-profile
   session carries the sign-in; a sign-in wall is an
   abort-and-escalate, not a recipe step).
2. **ONBOARDING - the first gate (confirmed never completed).**
   On `console.x.com/onboarding`, fill the portal signup:
   - Account name: the draft in section 3 (also drafted to serve
     as the App name later - one consistent identity).
   - Use-case textarea (required; the form asks for a
     "data protection" style rationale): the use-case text in
     section 3, written once to satisfy BOTH this onboarding field
     and the later app-creation "use case / justification" field.
   - Developer Agreement checkbox: tick (operator-approved
     acceptance of the X Developer Agreement via this document).
   - Optional marketing/updates checkbox: leave UNTICKED.
   - Submit.

   **Step 2b - PHONE VERIFICATION: operator action, not abort.** X may
   demand phone verification during dev-portal signup / account
   security. The prompt can appear on either surface: an
   x.com-origin account-security dialog (x.com asks the account to
   confirm a phone before enabling developer features), or an
   inline step inside `console.x.com` onboarding itself. When the
   recipe detects either, it pauses in an explicit
   `operator_required` state - result file written, bridge
   ask/notice sent naming which surface shows the prompt - and
   holds the session open. The developer then enters the phone
   number and the SMS code HIMSELF in the audit browser while the
   hands-agent waits. The recipe never reads, types or relays
   verification codes; it resumes only on the operator's bridge
   reply confirming the gate is passed.

   **Step 2c - TIER CHECK / BUDGET GATE.** Per x-twitter-driver-spec 1.1
   and confirmed by the developer: X API WRITE access is PAID
   since Feb 2026 - the free tier ended except classified Public
   Utility Apps, and self-serve moved to pay-per-use. The
   free/onboarding path is therefore EXPECTED to hit a paid-plan
   wall. The recipe never enters payment details. On hitting the
   wall it aborts, records in the failure result and the bridge
   notice the EXACT plan name and price the portal demands
   (verbatim from the paywall copy), and parks - the developer
   makes the budget decision and either approves a paid plan in a
   follow-up run or closes the track.
3. Create a Project, then an App inside it, using the metadata in
   section 3 field-for-field. If the portal re-asks for an app
   name or use case, reuse the SAME drafts submitted at
   onboarding - they were written to serve both.
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
8. Confirm `X_HANDLE` from the profile page - expected `varenicX`
   verbatim, without `@`; a mismatch is abort-and-escalate (the
   recipe would be operating on the wrong account).

## 3. App metadata - field-by-field draft texts

Minimal-disclosure rule: every field is truthful and descriptive;
nothing advertises automation scale, scheduled posting volume or
multi-account use. X reviews app metadata - understatement that is
accurate beats marketing that invites scrutiny.

The drafts below are written ONCE to serve both surfaces the run
meets: the `console.x.com/onboarding` signup (account name +
use-case textarea) and the later project/app creation form.

| Portal field | Draft value |
|---|---|
| Onboarding account name | `shared-person-content-tools` (same string reused for the App name unless the portal rejects it - one consistent identity) |
| App name | `shared-person-content-tools` |
| Description | `Personal developer tool used by the account owner to publish posts to their own X profile.` |
| Website URL | `https://github.com/ychetka/ai_trading` (the URL already registered on the LinkedIn app per session record - verify against `PLATFORM_ACCESS.md`; one consistent project identity) |
| Use case / data-protection rationale (onboarding textarea AND app "use case / justification") | `I am building a personal tool that publishes content I have written to my own X account. I review every post before it is sent. The app calls POST /2/tweets with my own credentials; it does not read other users' data, does not post on behalf of anyone else, does not run ads, and does not collect, store or share any third-party personal data.` |
| Callback / redirect URLs | none needed - OAuth 1.0a user context mints owner tokens in-portal; leave empty unless the form forces a value (then reuse the website URL) |
| Project name | `shared-person` (or the portal default) |

Notes for the approver:

- The use-case text says "content I have written" - accurate: every
  published draft passes the human moderation card first; the tool
  never posts unreviewed generated text.
- The added closing clause covers the onboarding form's
  data-protection ask ("does not collect, store or share any
  third-party personal data") while staying truthful for the
  app-level justification - the tool only ever touches the owner's
  own account data.
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
  `X_HANDLE=varenicX`; plus `X_DRIVER=api` when the driver ships.
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
      escalation contract: CAPTCHA abort-and-escalate via the
      orchestrator bridge, phone verification paused for the
      operator to pass himself (step 2b), paid-plan wall reported
      verbatim for a budget decision (step 2c).
- [ ] Onboarding drafts (section 3) approved for BOTH surfaces:
      the `console.x.com/onboarding` signup form and the later
      project/app creation fields.
- [ ] Developer Agreement checkbox: approving this document
      authorizes the recipe to tick it on the operator's behalf at
      `console.x.com/onboarding`.
- [ ] PAID-PLAN ACKNOWLEDGMENT: developer explicitly acknowledges
      that the X API write tier has been PAID since Feb 2026; the
      run is EXPECTED to hit a paid-plan wall, at which point the
      recipe aborts, reports the exact plan name/price, and the
      developer decides whether a paid plan is acceptable.
- [ ] Phone verification: developer confirms he is ready to enter
      the number/code himself in the audit browser when the recipe
      parks in `operator_required` (x.com account-security surface
      or console.x.com inline step).
- [ ] Secrets destination (section 4) approved: `../ENV` only, scrub
      sets when the driver ships, passthrough compose entries.
- [ ] Acknowledged: changing app permissions after token generation
      forces regenerating the user tokens (step 6).
- [ ] Acknowledged: this document authorizes building the recipe and
      one supervised run; the run itself still follows hands-agent
      UX rules (operator reachable via the bridge, shot audit
      trail, escalate on anything outside the written steps).

## 6. Sources

- Live audit-browser exploration 2026-11-08 (CDP :9223): `@varenicX`
  logged in on `x.com/home`; `developer.x.com` ->
  `console.x.com/onboarding` redirect; onboarding never completed
  (no apps/keys); onboarding form fields as itemized above;
  paid write-tier status per developer.
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

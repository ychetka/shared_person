# X (Twitter) - publish driver spec for sp-publish

Design input for the `platform: "x"` driver in sp-publish's Publish
Tick. The account exists and is logged-in inside the audit Chrome
profile (CDP :9223, `~/.chrome-audit-profile`, launched via
`tools/chrome-audit.sh`). API credentials do NOT exist yet - this
spec covers both the official API path (primary, once the developer
creates an app at developer.x.com) and an interim hands-agent
browser-automation fallback on the same audit profile (optional,
gated, interim).

Status: spec (2026-11-07), no implementation yet. Mirrors the VK and
LinkedIn driver contracts already live in `n8n/workflows/sp-publish.json`.

## 1. Platform research

### 1.1 Publication formats

- Tweet (post): 280 chars for a standard (non-Premium) account.
  X counts weighted characters - URLs fold to ~23 chars via t.co,
  CJK codepoints count double - so "280" is a weighted length, not a
  `String.length`. Premium long posts (up to ~25k chars) are OUT OF
  SCOPE: the pipeline targets the standard account tier.
- Media: up to 4 images per tweet, OR 1 GIF, OR 1 video - mixed
  image+video is not allowed. Image cap ~5 MB per image.
- Thread (reply chain): a sequence of tweets where each replies to
  the previous (`reply.in_reply_to_tweet_id`). This is the article
  carrier for X - see 2.4.
- Rate limits (self-serve, per X docs as of 2026-11):
  `POST /2/tweets` - 100/15min per user, 10,000/24h per app;
  media upload - 500/15min per user; `DELETE /2/tweets/:id` - 50.
  Separately, X enforces an account-level cap (~50 original
  posts/day for unverified accounts, reduced May 2026) that binds
  long before the API cap - irrelevant at our cadence (a few posts
  per day) but a real constraint if a thread storm ever appears.
- Access/billing: API write access is paid in 2026 (free tier ended
  Feb 2026 except classified Public Utility Apps; self-serve moved
  to pay-per-use). The developer must pick a plan when creating the
  app - budget check belongs in the readiness checklist (3.1), not
  the driver.

### 1.2 Auth options

Two user-context schemes can post (`POST /2/tweets` does not accept
the app-only Bearer token at all - Bearer is a read credential):

| | OAuth 1.0a user context | OAuth 2.0 PKCE user context |
|---|---|---|
| `POST /2/tweets` | yes | yes (`tweet.read tweet.write users.read`) |
| v2 media upload | yes | yes (`media.write` scope) |
| legacy v1.1 `upload.x.com` | yes | NO - rejects OAuth2 tokens |
| token expiry | none until revoked | ~2h; needs `offline.access` refresh (rotating) |
| callback needed | no (dev portal mints owner tokens) | yes (authorize URL -> redirect -> code exchange) |

DECISION: **OAuth 1.0a** is the primary scheme. Justification:

- This pipeline is a server-side daemon posting for ONE known
  account (the app owner's own account) - the dev portal generates
  the access token + secret directly in "Keys and tokens", no
  3-legged consent round-trip and no callback listener (unlike the
  LinkedIn `localhost:8793` re-auth flow).
- Tokens do not expire; nothing to refresh or rotate. The VK
  token-service machinery exists because VK tokens die in ~24h - X
  OAuth 1.0a removes that whole failure class.
- One credential set covers `POST /2/tweets`, both media upload
  paths and `GET /2/users/*` lookup endpoints; no per-scope
  re-consent when media is added later.

Caveat: X is steering integrations toward OAuth 2.0 (docs mark
OAuth 1.0a as legacy; a silent 1.0a -> 2.0 token-exchange grant
was reported in Sep 2026 - verify its current status against the
OAuth docs at build time before relying on it). The spec
therefore keeps the env layout
(2.3) mappable to OAuth 2.0 (`X_CLIENT_ID`/`X_CLIENT_SECRET` +
stored user token) so a future migration changes the signer, not
the driver contract. If OAuth 1.0a is ever rejected at runtime the
driver fails closed (`auth_error`), never silently.

### 1.3 API surface used

- Text tweet: `POST https://api.x.com/2/tweets`
  body `{"text": "...", "media": {"media_ids": [...]},
  "reply": {"in_reply_to_tweet_id": "..."}}`.
- Media upload (current, since Apr-Jun 2025):
  `POST /2/media/upload` single-shot for images;
  for larger payloads the chunked flow is
  `POST /2/media/upload/initialize` -> `POST /2/media/upload/:id/append`
  per chunk -> `POST /2/media/upload/:id/finalize` ->
  `GET /2/media/upload?command=STATUS` until processing reports
  `succeeded`. Returns `media_id` (24h lifetime).
  NOTE: older guides (and this brief) name the legacy v1.1
  `POST upload.x.com/1.1/media/upload.json` chunked flow
  (`command=INIT/APPEND/FINALIZE/STATUS` on one endpoint, OAuth
  1.0a only). X migrated upload to the dedicated v2 paths above and
  sunset the v1.1 endpoint in 2025; some setups still answer 2xx on
  it. IMPLEMENTATION RULE: the driver calls the v2 paths; the v1.1
  flow is a documented fallback only if v2 returns 404/410 at build
  time - verify once, then pin whichever answered.
- Verify/read-back: `GET /2/tweets/:id`.
- Orphan probe reads: `GET /2/users/by/username/<handle>` (resolve
  once) + `GET /2/users/:id/tweets?max_results=20&tweet.fields=created_at`.
- Test cleanup: `DELETE /2/tweets/:id` (own tweets only).

### 1.4 Failure surface

- 401/403 auth rejection (dead/revoked tokens, insufficient app
  permissions) -> terminal `auth_error`, same class as VK error 5 /
  LinkedIn `li_auth`.
- 403 "duplicate" content rejections and other definite 4xx API
  errors -> terminal `api_error` (post provably never ran).
- 429 rate limit, 500/502/503/504 -> transient, retryable requeue
  bounded by `RETRY_MAX=5` - same `TRANSIENT_*` semantics as
  `TRANSIENT_LI_STATUSES`/`TRANSIENT_VK_CODES`.
- No HTTP status at all (timeout/reset after the request left) ->
  the dangerous case: the tweet may have landed while the response
  was lost -> `maybe_live` + orphan probe (2.1), identical to the
  `ugcPosts`/`wall.post` transport-loss rule.

## 2. Integration spec

### 2.1 Driver contract (mirrors publishVk/publishLinkedin)

`publishX(t, fname)` inside Publish Tick, dispatched from the same
per-file loop (`p === 'x'` branch alongside the existing
`vk`/`linkedin` dispatch). Queue payload unchanged:
`{id, platform: "x", post_id, text, media[], image?, test?,
dry_run?/mock?, thread?, retries?}`.

- `PUBLISH_PLATFORMS` gate: add `'x'` to ALL FOUR copies of the
  SYNC'd `enabled-platforms` group (tools/check_sync.js
  `expect: 4`): the identical ALL_PLATFORMS/PLATFORM_ALIAS/ENABLED
  gate blocks in Publish Tick (sp-publish), Handle TG Update and
  Compose Message (sp-tg-moderation - the card's LIVE/SIM tag
  reads it), plus Generate Drafts' MAP (sp-content-gen) as an
  `x: ['writer-x']` key and a `MAP.all` entry. The token also
  joins `PLATFORM_TOKEN_RE` in tools/check_sync.js - the
  single-letter `x` needs whole-word care there so prose inside
  the copies cannot phantom-match it.
  An x draft with `x` not in `PUBLISH_PLATFORMS` parks in
  `skipped/` unchanged; an enabled-but-driverless platform parks in
  `skipped/` with `no driver for platform x` until this driver
  ships.
- Ledger: same never-throws `ledger()` appending to
  `state/published.jsonl` with `platform: 'x'` - statuses
  `dry-run`, `simulated`, `post-created`, `verify-failed`,
  `published`, `test-published-deleted`, `test-delete-failed`,
  `maybe-live`, `failed`, `ledger-append-failed`; the
  `publish.jsonl` fallback line on append failure is unchanged.
- Status file: a third per-platform file `state/x_status.json` via
  an `xStatus(s, reason, file)` writer and its own end-of-tick
  worst-status merge (`tickFiles`/`liTickFiles` sibling). Status
  vocabulary reuses the shared ranking: `ok`, `simulated`,
  `api_transient`, `publish_unverified`, `test_delete_failed`,
  `bad_json`, `stuck_claim_recovered`, `publish_error`, `api_error`,
  `auth_error`, `skipped`.
- Registry: `registryEvent({post_id, draft_id, platform: 'x',
  stage: 'publish', status, writer: 'sp-publish', ...})` - same
  fold: `published` gets `external_ids` + `published_at`;
  `test-published-deleted` -> `test-deleted`; `dry-run`/`simulated`
  keep their own status and no `published_at`; `failed` carries
  `maybe_live` + probe-recovered `external_ids`; `skipped` on the
  disabled/no-driver parks. A thread publishes with ALL tweet ids
  in `external_ids` (the array exists for exactly this - see
  post-registry-design.md).
- `postLink` gains an X arm: a real numeric tweet id renders
  `https://x.com/<X_HANDLE>/status/<id>`; `sim-*` stays literal
  with the ` (sim id)` tail. For threads the link points at the
  FIRST tweet.
- Media cap: `MEDIA_MAX = 4`. `media[]` (plus legacy `image`)
  resolves through the same `resolveMedia`/under-root rules; entries
  past the cap are dropped as `mediaFailed` entries
  (`over the 4-image x cap`), per-file failures are non-fatal and
  reported in `media_attached`/`media_failed` + the via line -
  identical N/M semantics to VK/LI.
- Char limit: the driver measures X-weighted length and FAILS
  CLOSED on over-280 text (terminal `api_error`-class throw before
  any call) - never silently truncates, matching the facts-only
  discipline. Long drafts are a writer-contract problem (2.4), not
  a publish-time fix.
- Empty guard: no text AND no attached media is terminal, same as
  both existing drivers.
- `test: true` drafts publish, verify via `GET /2/tweets/:id`, then
  `DELETE /2/tweets/:id`; a delete failure records
  `test-delete-failed` and leaves the post live, identical to LI.
- Orphan probe (transport loss / resolved response without id):
  `GET /2/users/by/username/<X_HANDLE>` (cached per tick) +
  `GET /2/users/:id/tweets?max_results=20&tweet.fields=created_at`,
  normalized-prefix text match (80-char head / 40-char floor, same
  rules as VK/LI) bounded by `author_id` + 10min window; a hit
  recovers `external_id` into a `maybe-live` ledger record.
- Retryable classification: `e.retryable` set on transient statuses
  {429, 500, 502, 503, 504} or no-HTTP-status transport errors
  BEFORE `POST /2/tweets` was sent (token/media phase - requeue is
  provably safe); the existing `t.retries`/`RETRY_MAX=5` bound, the
  link(2) hand-back and the exhausted-budget failed/ move apply
  unchanged.

### 2.2 PUBLISH_SIMULATE branch

Under `PUBLISH_SIMULATE` (`1`/`true`/`yes`, anything else = real),
the X driver runs claim -> media resolve -> ledger -> status ->
registry -> done/ with ZERO network - no media upload, no
`POST /2/tweets`, no verify GET, no test DELETE, and NO
hands-agent queue write either (sim must not post through the
browser path by the back door):

- Media still resolves (FS-only) and each resolvable file earns a
  `sim-media-<n>` id in the ledger `media_assets` - same N/M
  reporting a live run gives.
- Synthetic `external_id`: `sim-x-<draft_id>` (strip a `.json`
  tail from `fname` like the existing drivers). The `sim-x-`
  prefix can never parse as a numeric tweet id, so no reader can
  feed it to `DELETE /2/tweets/:id`.
- Same nothing-to-publish gate: empty text + zero resolvable media
  throws identically in sim mode - no fake `simulated` success.
- `test: true` under sim records `simulated` +
  `test_delete_skipped`, never a DELETE.
- The done/-file `simulated: true` stamp, `publishedIds()`
  `sim-`/`simulated` skip and re-approvability rules are inherited
  unchanged.

### 2.3 ENV / credentials (OAuth 1.0a, decided in 1.2)

`../ENV` additions (compose passthrough like `LINKEDIN_*`):

- `X_API_KEY` - app consumer key.
- `X_API_SECRET` - app consumer secret.
- `X_ACCESS_TOKEN` - user access token (the account's own).
- `X_ACCESS_SECRET` - user access token secret.
- `X_HANDLE` - the account's handle without `@`; feeds `postLink`
  and the orphan probe's user resolution.
- `X_DRIVER` - `api` (default) or `hands`; selects path (a) vs (b).

Not chosen: an `X_BEARER_TOKEN`-only variant - Bearer cannot post
(user-context only), so it would be dead config that looks like a
credential. `X_CLIENT_ID`/`X_CLIENT_SECRET` are reserved names for
the future OAuth 2.0 migration, not part of the primary path.

All four secrets join the scrub sets (`scrub()`/`KNOWN_TOKENS` in
sp-publish, `SECRET_VALUES` in sp-tg-moderation) - X secrets must
never reach `publish.jsonl`, the ledger, registry errors or the TG
summary. Sim mode must not require them (the
`if (!X_ACCESS_TOKEN && !SIMULATE) throw` relaxation pattern from
both drivers applies - a simulated tick runs before any credential
lands).

### 2.4 Content contract (the article problem)

The article spec's per-platform compression principle
(rewrite-to-fit, not truncation - content-article-spec.md "Platform
notes") applies: an article draft CANNOT reach X as raw text.

- Writer contract: `prompts/writer-x.txt` emits single-tweet text
  <=280 weighted chars (a compressed take - hook + one number + a
  question; per-platform compressed regeneration, NOT a slice of
  the VK article) OR a `thread[]` array of tweets, each <=280
  weighted.
- Thread option (the article carrier): `t.thread = ["tweet1",
  "tweet2", ...]`. Publish = `POST /2/tweets` for tweet 1, then
  each subsequent tweet with
  `reply.in_reply_to_tweet_id = <previous id>`. `external_ids`
  collects every id (first tweet is the link target / `postLink`
  anchor). Media attaches to the first tweet only.
  - A mid-thread transport loss is a PARTIAL maybe_live: tweets
    1..k landed, k+1..n unknown. The thrown error carries
    `orphan_id` = last confirmed id (or probe-recovered) and the
    failed file logs `partial thread - k/n tweets landed`; the
    operator hand-off names the break point. Never auto-resume a
    partial thread (dup-tweet risk on the boundary) - a re-Approve
    republishes the whole thread after the operator deletes the
    partial.
  - Media cap stays 4 for the whole draft (attached to tweet 1) -
    per-tweet media is a future extension.
- `[See Fig N]` pointers mean bottom-grid figures on VK/LI; on X
  they map to the same attached image grid on tweet 1 - the writer
  keeps the pointer style, at most 4 figures.

### 2.5 Interim browser path (b) - optional, gated

Until the dev-portal app exists, X is reachable through the
logged-in session in the audit Chrome profile (CDP :9223) via
hands-agent - the same session model VK/FB/IG/LI already use.

- Gate: `X_DRIVER=hands` (default `api`). The `hands` value is
  INTERIM - it exists to exercise the full claim -> ledger ->
  registry loop before credentials land, and retires once (a)
  works. Under `PUBLISH_SIMULATE` the driver still emits `sim-*`
  and enqueues NOTHING (the recipe would post for real).
- Mechanism: driver drops `{"recipe": "x_post", "params": {"text":
  ..., "image_path": "...", "text2": "...", "publish_label":
  "Post"|"Post all"}}` into
  `hands-agent/queue/inbox/` instead of calling the API; the recipe
  (`hands-agent/recipes/x_post.yaml` - written, not yet run; its
  first run is supervised and gated on an explicit developer START)
  would drive x.com's web composer in the audit-profile tab
  (`dom_find`/`click_dom` via `cdp.py` on the `x.com/home` target +
  OS-level `type`; per-step `shot` audit trail into `queue/done/`
  per hands-agent UX rules - verify before click, dismiss overlays
  first). Composer anatomy verified live 2026-11-09 (@varenicX
  session, EN UI, audit browser CDP :9223): left-nav `Post`
  (`[data-testid=SideNav_NewTweet_Button]`, the only exact-'Post'
  element pre-dialog) opens the compose `[role=dialog]`;
  `tweetTextarea_0` (`aria-label "Post text"`) autofocuses;
  `Add photos or video` -> hidden file input -> GTK file chooser
  (ctrl+l -> path -> Return); the dialog's publish button is
  `[data-testid=tweetButton]` with text "Post" - or "Post all" when
  a thread second post is attached. The driver passes
  `publish_label`: "Post" for a single post, "Post all" when
  `text2` is set. In SINGLE-POST mode `dom_rect`'s
  smallest-exact-match rule disambiguates the two 'Post' elements:
  inside the open dialog the smaller `tweetButton` wins over the
  larger nav `Post`. In THREAD mode "Post" exact-matches ONLY the
  nav button behind the modal (the dialog button no longer reads
  "Post"), so an unconditional "Post" target would click the nav
  button and return ok:true with nothing published - `publish_label`
  exists to prevent that silent false-success. The thread add-post
  "+" button (expected `data-testid=addButton`) is UNVERIFIED - the
  recipe's `text2` branch is marked for first-run verification.
- Preconditions (same gaps the Habr spec already tracks - resolve
  once for both): a `set_clipboard`/insert action for >280-char
  fields is NOT needed (tweets are short enough for jittered
  `type`), but the worker result channel IS required:
  `queue/done/<task_id>.result.json` carrying `{"url":
  "https://x.com/<handle>/status/<id>"}` so the driver can record
  `external_ids` - without it every hands publish is a blind
  `maybe_live`.
- Failure semantics: a recipe landing in `queue/failed/` after the
  Post click is the transport-loss analog -> `failed/` +
  `maybe_live`, orphan probe = open the X profile page and
  DOM-check the newest tweet text (habr-style probe); the API
  probe is unavailable pre-credentials.
- Discipline: 1 post per recipe run, human-approved drafts only
  (the moderation card stays the non-bypassable gate), no login
  flows inside recipes, CAPTCHA aborts escalate to the operator.

## 3. Risks / open questions

### 3.1 Developer auth-readiness checklist

Before `X_DRIVER=api` can go live:

1. Create a developer account at developer.x.com; create a Project
   + App (pick a paid/pay-per-use tier - free write access ended
   Feb 2026; confirm current pricing at signup).
2. App settings -> User authentication settings -> permissions
   "Read and write" (write required for `POST /2/tweets` and media
   upload).
3. "Keys and tokens" -> generate API Key + Secret, then Access
   Token + Secret for the owner account. All four land in `../ENV`
   as `X_API_KEY`/`X_API_SECRET`/`X_ACCESS_TOKEN`/`X_ACCESS_SECRET`;
   set `X_HANDLE`.
4. Compose: add the vars to `docker-compose.yml` n8n env
   (passthrough, not `${VAR:?}` - X is optional like the LinkedIn
   vars) and `x` to `PUBLISH_PLATFORMS` when ready.
5. Smoke: a `dry_run: true` queue file (zero calls), then a
   `test: true` file once `PUBLISH_SIMULATE=0` (publishes +
   verifies + deletes a real tweet).
6. Verify a real signed call once outside n8n (curl with an OAuth
   1.0a signature) to catch a dead token before the first live
   Approve.

### 3.2 Known risks

- Credential retirement: OAuth 1.0a is marked legacy by X (the
  reported Sept 2026 token-exchange grant signals migration
  intent). Mitigation:
  env layout already maps to OAuth 2.0; a rejected 1.0a signature
  surfaces as terminal `auth_error`, never a silent post.
- v1.1 media upload docs are stale across the ecosystem (2025
  migration). Pin whichever upload path answers at build time; the
  spec's primary is the v2 dedicated-path flow.
- Web-composer DOM fragility on the interim path (composer is the
  most likely drift point, same as Habr's hub picker) - the recipe
  must use locate/verify loops, not fixed coordinates.
- Duplicate-content rejections (403) on re-Approve of identical
  text: terminal by classification; the operator sees the definite
  API error and edits instead of blind-retrying.
- Account-level posting caps (unverified ~50/day) bind before API
  limits - irrelevant at target cadence, documented so a future
  burst doesn't misread a 403 as an auth failure.

## 4. Acceptance criteria (for the future driver issue)

- `PUBLISH_PLATFORMS` contains `x`; an enabled x draft reaches
  `publishX`, a disabled one parks in `skipped/`, a driverless one
  reports `no driver for platform x`.
- `PUBLISH_SIMULATE=1`: sim-* external_id (`sim-x-<draft_id>`),
  `sim-media-<n>` assets, zero network AND zero hands-agent queue
  writes, registry `publish/simulated`, `done/` payload stamped
  `simulated: true`, draft stays re-approvable for go-live.
- `dry_run: true` / `mock: true`: zero X calls, ledger `dry-run`
  with `media_resolved`/`media_failed`, registry `publish/dry-run`.
- Live (`X_DRIVER=api`): text tweet publishes via `POST /2/tweets`,
  `external_ids` = numeric tweet id, postLink renders
  `https://x.com/<X_HANDLE>/status/<id>`; up to 4 images via media
  upload + `media_ids`; `test: true` publishes -> verifies ->
  deletes (`test-published-deleted`); over-280 fails terminal
  before any call; 429/5xx requeue bounded at `RETRY_MAX=5`;
  401/403 -> `auth_error`; transport loss -> `failed` +
  `maybe_live` + probe-recovered id.
- Thread: `t.thread[]` publishes as a reply chain, all ids in
  `external_ids`, `postLink` anchors tweet 1; a mid-thread loss
  reports the break point, never auto-resumes.
- Interim path (`X_DRIVER=hands`): recipe enqueue + result-channel
  URL recorded in `external_ids`; recipe failure after Post ->
  `failed` + `maybe_live`; SIMULATE enqueues nothing.
- No credential material in queue payloads, ledger, logs, registry
  or TG output (all four secrets in the scrub sets).

## 5. Sources

- X API v2 tweet creation / auth mapping / media upload / rate
  limits - docs.x.com (verified via ecosystem docs 2026-11;
  POST /2/tweets user-context only; media.write on v2 upload;
  v1.1 upload.x.com sunset mid-2025).
- OAuth 1.0a vs 2.0 PKCE coverage and the 1.0a retirement signal:
  X OAuth docs + the reported token-exchange grant (Sep 2026) -
  re-verify at build time.
- Media caps (4 images / 1 GIF / 1 video, 5 MB) and 280-char
  weighted counting: X help center.
- Driver contract mirrored from `n8n/workflows/sp-publish.json`
  Publish Tick (publishVk/publishLinkedin), `docs/post-registry-design.md`,
  `docs/habr-integration-spec.md` (hands-agent queue contract +
  result-channel precondition), `PLATFORM_ACCESS.md` (audit
  browser, env conventions).

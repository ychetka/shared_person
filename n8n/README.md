# n8n content pipeline

Workflow specs live in `workflows/` (deploy format documented in
`../n8n-workflows/README.md`). Deploy with the offline SQLite deployer:

```bash
docker stop shared-person-n8n
node ../tools/deploy_workflow.js workflows/<name>.json           # insert
node ../tools/deploy_workflow.js workflows/<name>.json --update  # new version
docker compose --env-file ../../ENV up -d n8n
```

All state files live inside the n8n storage volume under
`/home/node/.n8n/` (container view; on the host it is the volume root,
not the nested `.n8n/` that holds `database.sqlite`):

- `state/tg.json` - operator Telegram chat_id (written by sp-tg-setup;
  compat fallback for the pinned `TELEGRAM_CHAT_ID` env)
- `state/drafts/<id>.json` - moderation drafts
- `state/trend_seen.json` - trend-scout dedupe (7 days)
- `state/digest.json` - last digest items keyed by date + index
  (RSS and VK items share the index space), resolved by the `post N`
  reply (3 days kept)
- `queue/publish/{,done,failed,skipped,processing}` - approved posts
  waiting for drivers; non-enabled platforms land in `skipped/`;
  `processing/` holds files claimed by a running tick. A claim stuck
  there after a crash is auto-recovered to `failed/` after ~10min
  with a `maybe_live` ledger note - the `wall.post` may already have
  landed, so check the VK wall first, then approve the draft again to
  re-publish. Never move a stuck claim back to the queue root
  manually: that skips the wall check and can duplicate the post
- `logs/{moderation,content-gen,publish}.jsonl` - audit trail

The hands-agent queue is bind-mounted at `/home/node/hands-queue`
(host: `../hands-agent/queue/`). The project `materials/` directory is
bind-mounted read-only at `/home/node/materials` (host:
`../../materials/`) - media candidates from briefs resolve there for
the moderation `sendPhoto` step.

## Workflows

### sp-tg-setup (manual)

One-time bootstrap. Resolves the operator chat_id - `TELEGRAM_CHAT_ID`
env first, `state/tg.json` from a previous run next, and only when
neither exists AND no webhook is registered yet, a `getUpdates`
self-heal that takes the LAST sender's chat_id. That fallback pins
whoever messaged the bot last, so a third party writing between the
operator's `/start` and the setup run would become "operator" - the
result `note` carries an explicit WARNING when `getUpdates` saw more
than one distinct chat. Writes the id to `state/tg.json`, then calls
`setWebhook` pointing at `/webhook/tg-moderation` on `WEBHOOK_URL`
with `secret_token=$TG_WEBHOOK_SECRET`.

`TG_WEBHOOK_SECRET` is REQUIRED: the workflow aborts with an explicit
error when it is unset. Registering without `secret_token` would leave
every delivery unsigned while the tg-moderation gate fails closed -
a silent dead pipeline that still reports "webhook registered".

Run it manually after the user sends `/start` to @shared_person_bot.
Repeatable CLI equivalent: `tools/tg_webhook_setup.sh` - registers the
same URL + `secret_token` and prints `getWebhookInfo`; run it again
after rotating `TG_WEBHOOK_SECRET`.

Since the authenticity gate landed, `tg-moderation` drops every update
whose `X-Telegram-Bot-Api-Secret-Token` header does not match
`TG_WEBHOOK_SECRET` (fail closed - the bot goes quiet when the env is
missing), and only acts on updates from the pinned operator chat
(`TELEGRAM_CHAT_ID` env, `state/tg.json` fallback). Updates are never
used to learn `chat_id` - the old self-heal let any posted message
rewrite `tg.json` and hijack previews.

### sp-tg-moderation (webhooks)

- `POST /webhook/moderation-draft` `{platform, text, image?, topic?,
  draft_id?, scope?, warnings?, media?, caption_note?, test?}` - saves a draft,
  sends it to the Telegram chat with inline buttons Approve / Edit /
  Reject (`callback_data` = `ap|ed|rj:<id>`). `scope` is rendered above
  the text; `warnings[]` (verifier flags) are appended as a block under
  the text and stored in the draft meta.
  - shared-secret gate: the endpoint is reachable through the public
    edge proxy, so every call must carry `X-Shared-Token` or
    `X-TG-Draft-Secret` matching `DRAFT_WEBHOOK_SECRET` (constant-time
    compare, fails closed when the env is unset). Without it unlimited
    draft previews with live Approve buttons could be pushed into the
    operator chat. The internal caller (sp-content-gen) sends
    `X-Shared-Token`; a rejected call answers `{ok:false}` and nothing
    is written or sent.
  - `draft_id` overwrite guard: the webhook is public, so an existing
    `state/drafts/<id>.json` may only be replaced when its moderation
    is already decided AND a rewrite is expected - `status` must be
    `rejected` (dead draft, id free for reuse) or `rewrite` (set by
    Handle TG Update when an Edit rewrite is dispatched to
    content-gen, which reuses the same `draft_id`). `pending`,
    `approved` or any unknown status refuses the write
    (`{ok: false, error: "draft exists ..."}`) - otherwise a caller
    could swap the text under a preview the operator is about to
    Approve (the queue payload snapshots `d.text` at Approve time).
    `rewrite` is a bounded window, not a standing permit: the draft
    carries `rewrite_issued_at` from dispatch, and ~15min later the
    window expires - the draft is then treated as `rejected` and the
    arriving write is accepted in the same pass (flagged
    `rewrite_window_expired` in the response). Refuse-and-retry would
    silently drop a slow-but-legit rewrite: content-gen does not
    retry. A corrupt/unreadable draft file is refused outright
    (`{ok: false, error: "draft file exists but is unreadable"}`) -
    never treated as absent.
  - `media[]` - selected media paths (from the media-selector pass).
    Each path is resolved inside the container: literal path, anything
    under `materials/` maps to the read-only `/home/node/materials`
    mount, bare filenames are looked up in `materials/photos/`.
    Resolvable files go to the chat via `sendPhoto` (multipart upload
    built in the Code node, before the text message). Files that fail
    resolution or upload are listed in the message text instead, and
    the draft meta keeps `media`, `caption_note` and `media_sent`.
  - On Approve the `media[]` list is carried into the publish queue
    file so platform drivers can attach the same files.
- `POST /webhook/tg-moderation` - Telegram webhook target. Every update
  must carry `X-Telegram-Bot-Api-Secret-Token` matching
  `TG_WEBHOOK_SECRET` (registered via `setWebhook`'s `secret_token`,
  see `tools/tg_webhook_setup.sh`) and come from the pinned operator
  chat (`TELEGRAM_CHAT_ID` env, `state/tg.json` fallback) - anything
  else is dropped before it can touch drafts or the publish queue:
  - Approve > writes `queue/publish/<id>.json` (carries `test: true`
    through from the draft meta when set), marks the TG message. A
    draft whose platform is not in `PUBLISH_PLATFORMS` is refused with
    one uniform answer
    (`platform "x" is disabled in the publish tick - enable it first,
    then approve again`) whether the Approve is fresh or a re-approve
    from `skipped/` - 'Queued for publish' would misreport a publish
    that only parks in `skipped/` on the next tick.
    When a queue file already exists (root or `processing/`) and its
    payload differs from the current draft - e.g. an Edit + rewrite
    regenerated the draft under the same `draft_id` after the first
    Approve - the queued file's payload is synced to the latest draft
    in place (atomic dot-tmp + rename) instead of refusing, so the
    corrected text is what reaches the wall. An identical payload
    still answers `already queued`. The sync guards the same race the
    enqueue path does: the tick-owned dirs are checked right before
    AND after the rename, and if a competing `<id>.json` copy shows up
    in `processing/` or a terminal dir (the tick claimed/moved the old
    file in the gap), the fresh file is retracted instead of becoming
    a second queue entry - otherwise both payloads would reach the
    wall. A copy whose payload already matches the fresh write is the
    tick claiming OUR file (root > `processing/`): that is the single
    intended publish, not a duplicate.
  - Reject > marks draft rejected, logs to `moderation.jsonl`
  - Edit > stores a pending-edit marker; the next plain-text message in
    the chat is forwarded to `/webhook/content-gen` as a rewrite request
    (mode `rewrite`, with feedback + previous draft). The draft flips
    to `status: "rewrite"` and stamps `rewrite_issued_at` at dispatch
    so the regenerated version can reclaim the same `draft_id` under
    the (time-bounded) overwrite guard above. If the dispatch call
    itself fails, the draft reverts to its previous status - the
    window closes immediately instead of expiring on the clock. The
    same ~15min window bounds Approve too: while it is live Approve is
    refused `rewrite in flight`; once expired (the rewrite never
    arrived) the draft flips to `rejected`, the preview keyboard is
    restored, and the operator decides fresh - Approve again publishes
    the last text, or Edit / Reject.
    `status: "approved"` is only persisted after the queue file is
    confirmed to exist - a hard enqueue failure leaves the draft in
    its previous status instead of stuck `approved` with nothing
    behind it.
  - `post N` (plain text) > resolves item N from `state/digest.json`
    (newest stored day first), builds a `source_type: "hype"` brief
    (facts = source/published/metrics/angle/summary, links, scope,
    accents) and calls `/webhook/content-gen` with `platform: all`.
    Drafts come back through the normal moderation flow. Unknown N or
    missing digest gets a "no digest item" reply. `post N` is matched
    before the pending-edit state - an exact command never becomes
    edit feedback.

### sp-trend-scout (schedule, daily 09:00)

`POST rss-reader:8788/curate?since=24h` > dedupe vs `trend_seen.json` >
top-8 digest message to Telegram. Items arrive pre-scored: the
rss-reader attaches engagement metrics (Habr article stats, HN points)
and a `hype` 0-100 score - see `../rss-reader/README.md` for the
formula - and orders by hype desc. Each digest line shows
`[hype NN | fit S.S]`, a metrics line when available
(`views | comments | votes`), and the curator `angle`. Item #1 is
marked `> POST CANDIDATE`; the footer says
`Reply: post N - to generate hype-commentary draft on item N`.
The top-8 items are cached to `state/digest.json` so the reply path in
sp-tg-moderation can resolve them. Skips silently when nothing new or
chat_id is not resolved yet.

VK branch (`VK Top Posts` Code node between `Curate Feed` and
`Format Digest`, needs `VK_ACCESS_TOKEN` + `VK_USER_ID`):

- Community list comes from the live subscription scan:
  `groups.get` (extended) filtered by a pillar keyword expression
  (n8n/automation, frontend/programming, algo trading, dev/it).
  When the scan fails or matches nothing, a fallback list of public
  walls is used instead (`habr_com`, `webstandards_ru`, `proglib`,
  `smart_lab` - edit the `FALLBACK` array in the node).
- Per community (max 8) `wall.get` pulls the last 20 posts; only
  posts from the last 48h count, pinned posts and ads are skipped.
- Scoring is engagement only (no rss-reader curator), mirroring the
  rss-reader log-normalized shape:
  `0.45*ln1p(comments)/ln1p(300) + 0.35*ln1p(likes)/ln1p(2000) +
  0.2*ln1p(views)/ln1p(100000)`; `hype` = 100 * engagement.
  Top 2 posts per community are kept, then capped at 6 VK items total.
- VK items render as a `VK communities` section under the RSS list.
  They share the same index space (`post N` resolves them) and the
  same `digest.json` / `trend_seen.json` state (vk ids look like
  `vk:-<group_id>_<post_id>`).
- API failures degrade quietly: a rejected token (error 5) flips
  `vk_status` to `auth_error`, other failures land in `vk_error` /
  `vk_errors`, flood control (error 9) gets one delayed retry per
  call. The RSS digest still goes out; the VK section is replaced by
  a one-line skip note.

### sp-content-gen (webhook)

`POST /webhook/content-gen` `{topic, platform, context?, mode?,
feedback?, draft_id?, image?, scope?, accents?, links?, media?,
source_type?, viz_data?, gen_image?}`.
`platform`: linkedin | facebook | vk | all. `scope` (string),
`accents[]` and `links[]` bound the writers; when `context` carries a
serialized brief per `../brief/schema.json`, these fields are picked up
from it automatically - explicit payload fields win. `media[]` lists
candidate files (paths or `{path, desc}` objects); the same merge rule
applies when a serialized brief carries `media[]`. `source_type` and
`viz_data[]` likewise come from the payload or the serialized brief.

Brief gate (source > brief > draft, see `../brief/README.md`):
`context` is expected to carry the serialized content brief or raw
source material. If `context` is missing, shorter than 200 chars, or
contains fewer than 2 digit-bearing tokens (versions, counts,
percents), generation is skipped, `stage: 'brief-gate'` is logged, and
the resolved Telegram chat gets "no material in brief". This applies to
rewrite requests too (their context is the previous draft).

Passes (all LLM calls go through llm-gateway `POST :8787/run`):

1. `extract-facts` (gemini-3.5-flash) - raw context > strict JSON facts
2. `writer-linkedin` / `writer-fb` / `writer-vk` (gemini-3.6-flash) - one
   run per platform; the input brief carries scope/accents/links so the
   writer stays inside the article bounds
3. anti-slop filter (banned EN/RU phrases incl. "важно/критично/мелочь",
   emoji bullets, >=2 fact entities) - on violations one rewrite pass
   with feedback
4. humanizer - deterministic cleanup: em/en dash > `-`, zero-width
   chars, smart quotes, ellipsis char, non-breaking space
5. verifier pass (`critic` role) - checks the draft against brief
   facts, scope and links. Invented claims or scope violations trigger
   one rewrite attempt; remaining issues are attached to the draft as
   `warnings[]` and shown in the moderation message. A verifier outage
   marks the draft "not fact-checked" instead of blocking it.
6. media - three paths depending on the source:
   - session posts (`source_type: session` or any `viz_data[]`
     present): GENERATED charts. The `viz-spec` role gets the draft
     text + accents + `viz_data[]` and picks 0-2 chart specs
     (`bar|line|pipeline|stat-cards`, each referencing a dataset id).
     The workflow then POSTs `{draft_id, specs, viz_data}` to the
     host render daemon (`VIZ_RENDERER_URL`, default
     `http://10.0.2.2:8791/render` - `tools/render_viz.py --serve`;
     10.0.2.2 is the slirp gateway to the real host in rootless docker),
     which draws PNGs into `materials/viz/<draft_id>_*.png` and returns
     paths. Render/spec failures degrade to text-only. Each produced
     draft gets a stable id here (payload `draft_id` or generated,
     role-suffixed on multi-platform runs) so PNG names map 1:1 to
     moderation drafts.
   - generated-image posts (`gen_image: true` in the payload or the
     serialized brief, OR a non-retro non-session `source_type` like
     `hype`/`hot-topic`): the `image-gen` role gets the draft text +
     accents + topic and emits 1-2 text-to-image prompts (flat minimal
     dark tech illustration, no text in image, no logos). Each prompt
     is POSTed to llm-gateway `/image`, which renders it via a Gemini
     image model into `materials/img/<draft_id>_<i>.<ext>` and returns
     `materials/img/...` paths for sendPhoto. Generation failures
     degrade to text-only.
   - other posts (retro/archive, untyped): the `media-selector` role
     runs only when candidates exist (payload `media[]` or brief
     `media[]`). It gets the finished draft text + accents +
     `{path, desc}` candidates and picks 0-2 files matching the
     draft's accents; an empty selection is valid.

   Selected/generated paths plus `caption_note` are attached to the
   draft meta and forwarded to moderation, which delivers them via
   `sendPhoto`.

Each draft is POSTed to `/webhook/moderation-draft` for moderation
with `scope`, `warnings`, `media` and `caption_note` fields.

Generated media status: chart visualizations from `viz_data` are live
(matplotlib, see `../tools/README.md`), and AI image-gen is live via
llm-gateway `POST /image` (Gemini image models, see
`../llm-gateway/README.md`). The gateway writes files into
`materials/img/` on the host through a dedicated writable mount; the
n8n `materials` mount stays read-only. The legacy `image` field on
moderation-draft still accepts a pre-made local path/URL.

### sp-publish (schedule, every 2 min)

Scans `queue/publish/` and routes per platform. Each file is claimed
atomically before the first VK call - renamed into
`queue/publish/processing/` - so an overlapping tick sees the file
gone and cannot double-publish. Currently VK only (issue #1): the
`ENABLED` map gates execution and is built from the
`PUBLISH_PLATFORMS` env var (comma-separated, default `vk`, injected
via `docker-compose.yml`) - the same var sp-tg-moderation's Handle TG
Update reads for its requeue gate, so the two cannot drift. Every
non-enabled platform's queue file is moved to
`queue/publish/skipped/` with a
`platform not enabled` log line - nothing goes to FB/LI/IG/TikTok.
Note the `skipped/` gate is env-only: a platform that IS listed in
`PUBLISH_PLATFORMS` but has no implemented driver passes the gate and
then fails on `no driver for platform <p>`, landing in `failed/`
instead (only `vk` ships a driver today).
After enabling a platform, re-approve its parked drafts to re-queue
them - the Approve path drops the stale `skipped/` copy and writes a
fresh queue file (it refuses while the platform is still disabled).

VK driver flow per queue file `{platform: "vk", text, media[], test?}`:

1. `wall.post` with `owner_id=$VK_USER_ID` and `message=text`.
   Text-only for now - `media[]` is carried through but not attached
   (wall photo upload is a follow-up).
2. Ledger-first: a `post-created` record carrying `external_id` is
   appended to `state/published.jsonl` immediately after `wall.post`
   returns - before verification - so a later failure cannot orphan a
   live wall post without a recorded id.
3. Post-publish verification: `wall.getById` on `<owner>_<post_id>`
   must read the post back. A verify failure is appended as a
   `verify-failed` record and tolerated (the post is live either way);
   otherwise the `published` record gets `verified: true`. Records
   look like `{ts, id, platform, external_id, status, verified, test,
   deleted, media_ignored}` - minimal ledger until the full registry
   lands (issue #12).
4. Test posts (`test: true` in the queue file, passed through from the
   draft meta by moderation - the flag is a strict JSON boolean, only
   `true` counts; `"yes"`/`1` are treated as real posts): after the
   `published` record the driver calls `wall.delete` and appends a
   second record - status `test-published-deleted` on success, or
   `test-delete-failed` + `delete_error` when the delete call fails.
   A delete failure still lands the file in `done/`: the earlier
   records already hold the published+verified evidence and the wall
   post id.
5. `state/vk_status.json` reflects the full outcome: `ok` only on a
   fully clean run - `publish_unverified` when wall.getById could not
   confirm the post, `test_delete_failed` when a test post stayed
   live, `auth_error` on a persistent VK error 5.

VK API calls send `access_token` in the POST body (form-encoded),
never in the request URL, and every error string written to
`publish.jsonl`, the ledger or the Telegram summary is scrubbed of
`access_token=` values first.

VK token handling: the Code node prefers the cached token in
`state/vk_token.json`, falls back to `VK_ACCESS_TOKEN` env. On VK
error 5 (expired/rejected) it calls the host refresh service
`tools/vk_token_service.py` at `VK_TOKEN_REFRESH_URL` (default
`http://10.0.2.2:8792/vk-token`), persists the fresh token to
`vk_token.json` and retries once. A persistent error 5 marks
`state/vk_status.json` as `auth_error` and the file lands in `failed/`.

Processed files move to `done/` or `failed/` and are logged to
`publish.jsonl` (the logged `status` mirrors the ledger:
`published` / `test-published-deleted` / `test-delete-failed`, not a
flat `published` for test drafts); results are summarized to Telegram.

## Secrets

All tokens come from container env (`../ENV` via compose
`--env-file`), read in Code nodes with `$env` - never hardcoded in node
parameters. `PUBLISH_PLATFORMS` (comma-separated, default `vk`) is the
single source for the ENABLED gates in sp-publish and
sp-tg-moderation. Required compose vars: `TELEGRAM_BOT_TOKEN`,
`GEMINI_API_KEY` (llm-gateway), `VK_ACCESS_TOKEN`, `VK_USER_ID`,
`LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_PERSON_URN` (last four optional -
VK can run on the refresh-service token alone, and non-VK platforms go
to `skipped/` via the ENABLED gate regardless of env vars).
`VK_TOKEN_REFRESH_URL`
is an optional override for the VK token refresh endpoint (default
`http://10.0.2.2:8792/vk-token`). `TG_WEBHOOK_SECRET` is REQUIRED for
moderation to work - it is the `secret_token` Telegram signs webhook
deliveries with (`tools/tg_webhook_setup.sh` registers it; without it
the tg-moderation gate fails closed). `DRAFT_WEBHOOK_SECRET` is
REQUIRED for draft delivery - it gates `POST /webhook/moderation-draft`
(`X-Shared-Token`/`X-TG-Draft-Secret` header; fails closed when unset)
and sp-content-gen sends it on the internal dispatch.
`TELEGRAM_CHAT_ID` pins the
operator chat (`state/tg.json` is the fallback). Code nodes need
`N8N_BLOCK_ENV_ACCESS_IN_NODE=false` (set in docker-compose.yml).
